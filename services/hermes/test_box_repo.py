"""The writer that copies a job's GitHub bundle into its box's /repo, on this host's git, and the parity of the copy's
numbers and patterns across github.py, repo_fetch.py, box_repo.py, security_launcher.py and the store (ADR-0209)."""
import hashlib
import inspect
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.operations.connections import github
from tools.operations.installation.configuration import ROOT
from tools.runtime import box_repo, repo_fetch
from . import job_box
from . import repo_fixture as fixture
from . import security_launcher as launcher


def image_gitconfig(folder,root='/repo'):
    """A copy of the box image's /etc/gitconfig, from the Dockerfile's own `git config --system` lines, with /repo
    standing for `root`."""
    path=Path(folder)/'gitconfig'
    for key,value in re.findall(r'git config --system (?:--add )?(\S+) (\S+)',(ROOT/'deploy/box.Dockerfile').read_text()):
        if key=='safe.directory':value=value.replace('/repo',str(root),1)
        subprocess.run(['git','config','--file',str(path),'--add',key,value],cwd=str(folder),check=True,
                       env={'PATH':'/usr/bin:/bin','HOME':str(folder),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'})
    return path


class Writer:
    """One writer run in a temporary /repo, with the bundle on a pipe."""
    def __init__(self,test,variant=None,extra=False):
        folder=tempfile.TemporaryDirectory();test.addCleanup(folder.cleanup)
        self.folder=Path(folder.name);self.root=self.folder/'repo';self.root.mkdir(mode=0o755)
        self.work,self.commit=fixture.made(self.folder/'source',variant)
        blob=fixture.git(self.work,'hash-object','-w','--stdin',data=b'held back\n').strip().decode() if extra else None
        self.data=fixture.bundle(self.work,self.folder/'in.bundle',blob)
        self.need=10*1024**2

    def argv(self,seconds='600',**changes):
        values={'name':fixture.NAME,'branch':fixture.BRANCH,'commit':self.commit,'bytes':str(len(self.data)),'need':str(self.need),
                'digest':hashlib.sha256(self.data).hexdigest(),'seconds':seconds,**changes}
        return ['copy',*(values[k] for k in ('name','branch','commit','bytes','need','digest','seconds'))]

    def run(self,argv=None,sent=None,keep_open=False):
        """Runs the writer; returns its exit code and the bytes it left unread on stdin."""
        read,write=os.pipe();data=self.data if sent is None else sent
        def feed():
            with os.fdopen(write,'wb') as pipe:
                try:pipe.write(data)
                except BrokenPipeError:pass
        thread=threading.Thread(target=feed);thread.start();umask=os.umask(0)
        try:code=box_repo.main(argv or self.argv(),str(self.root),read)
        finally:os.umask(umask)
        left=b''
        while chunk:=os.read(read,1<<16):left+=chunk
        thread.join();os.close(read)
        return code,left

    def manifest(self):return json.loads((self.root/'manifest.json').read_text())

    def leftovers(self):return sorted(p.name for p in self.root.iterdir() if p.name.startswith('.stage-'))


def recording(calls):
    real=subprocess.run
    def run(command,**kwargs):calls.append((command,kwargs));return real(command,**kwargs)
    return run


class WriterTests(unittest.TestCase):
    def test_a_full_copy_lands_read_only_at_the_commit_with_its_manifest_last(self):
        writer=Writer(self);calls=[];order=[]
        real=box_repo.write_manifest
        def manifest(root,name,branch,commit,state,*args,**kwargs):
            order.append((state,(Path(root)/'code').exists()));return real(root,name,branch,commit,state,*args,**kwargs)
        with patch.object(box_repo.subprocess,'run',recording(calls)),patch.object(box_repo,'write_manifest',manifest):
            self.assertEqual(writer.run()[0],0)
        code=writer.root/'code'
        self.assertEqual(writer.manifest(),{'repo':fixture.NAME,'branch':'main','commit':writer.commit,'state':'ready','reason':None,'files':fixture.FILES})
        self.assertEqual(order,[('copying',False),('ready',True)],'the job sees copying, then the whole copy and its manifest')
        self.assertEqual(stat.S_IMODE((writer.root/'manifest.json').stat().st_mode),0o444)
        self.assertEqual(fixture.git(code,'rev-parse','HEAD').strip().decode(),writer.commit)
        self.assertIn('REPOMARK1',(code/'src/widget.py').read_text())
        self.assertIn(b'REPOMARK2',fixture.git(code,'log','--format=%s'))
        # The fetch is exact, with --update-head-ok; and every git call has the writer's own environment.
        fetch,=[command for command,_ in calls if 'fetch' in command]
        self.assertEqual(fetch,['git','-C',str(Path(fetch[2])),'fetch','-q','--update-head-ok','--no-tags','--no-write-fetch-head','../in.bundle',
                                '+refs/heads/main:refs/heads/main'])
        for command,kwargs in calls:
            env=kwargs['env'];config={env['GIT_CONFIG_KEY_%d'%n]:env['GIT_CONFIG_VALUE_%d'%n] for n in range(int(env['GIT_CONFIG_COUNT']))}
            self.assertEqual({k:config[k] for k in ('pack.threads','index.threads','checkout.workers','core.deltaBaseCacheLimit')},
                             {'pack.threads':'1','index.threads':'1','checkout.workers':'1','core.deltaBaseCacheLimit':'32m'})
            self.assertEqual((env['HOME'],env['GIT_CONFIG_NOSYSTEM'],env['GIT_CONFIG_GLOBAL'],config['core.symlinks']),('/nonexistent','1','/dev/null','false'))
            self.assertEqual((kwargs['stdout'] in (subprocess.DEVNULL,subprocess.PIPE),kwargs['stderr']),(True,subprocess.DEVNULL))
        # The symlink is a small file holding its target; no hooks, no remote, no FETCH_HEAD.
        escape=code/'escape';self.assertFalse(escape.is_symlink());self.assertEqual(escape.read_text(),'/etc/passwd')
        self.assertEqual((code/'vendor/lib').is_dir(),True);self.assertEqual(list((code/'vendor/lib').iterdir()),[])
        self.assertFalse((code/'.git/hooks').exists());self.assertFalse((code/'.git/FETCH_HEAD').exists())
        self.assertNotIn('remote.',(code/'.git/config').read_text().replace('[remote','remote.'))
        # Box commands see a clean checkout under the image's gitconfig.
        status=subprocess.run(['git','-C',str(code),'status','--short'],env={'PATH':'/usr/bin:/bin','HOME':str(writer.folder),
                              'GIT_CONFIG_SYSTEM':str(image_gitconfig(writer.folder)),'GIT_CONFIG_GLOBAL':'/dev/null'},capture_output=True,check=True)
        self.assertEqual(status.stdout,b'')
        # Nothing is group- or other-writable; the lock is the writer's alone; no stage is left.
        for path in [writer.root/'manifest.json',*code.rglob('*'),code]:
            self.assertFalse(path.lstat().st_mode&0o022,path)
        self.assertEqual(stat.S_IMODE((writer.root/'.lock').stat().st_mode),0o600)
        self.assertEqual(writer.leftovers(),[])

    @unittest.skipUnless(os.geteuid()==0,'needs root to run git as another uid')
    def test_box_commands_read_the_copy_as_another_uid_and_cannot_hold_the_lock(self):
        writer=Writer(self);self.assertEqual(writer.run()[0],0)
        for path in [writer.root,*writer.root.rglob('*')]:os.lchown(path,65531,65531)
        config=image_gitconfig(writer.folder,writer.root);config.chmod(0o644);os.chmod(writer.folder,0o755)
        def box(*command):
            return subprocess.run(list(command),user=65532,group=65532,cwd=str(writer.root/'code/src'),capture_output=True,
                                  env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_SYSTEM':str(config),'GIT_CONFIG_GLOBAL':'/dev/null'})
        for command in (('git','log','--oneline'),('git','grep','REPOMARK1'),('git','blame','widget.py'),('git','status','--short')):
            result=box(*command);self.assertEqual(result.returncode,0,command)
        self.assertEqual(box('git','status','--short').stdout,b'')
        self.assertNotEqual(box(sys.executable,'-c','import os;os.open("../../.lock",os.O_RDONLY)').returncode,0)
        self.assertEqual(writer.run()[0],0,'the copy is still ready; nothing a box command did holds the lock')

    def test_short_extra_or_other_bytes_leave_nothing(self):
        for sent in ('short','extra','digest'):
            with self.subTest(sent=sent):
                writer=Writer(self)
                if sent=='digest':code,_=writer.run(writer.argv(digest='0'*64))
                else:code,_=writer.run(sent=writer.data[:len(writer.data)//2] if sent=='short' else writer.data+b'x')
                self.assertEqual(code,3)
                self.assertFalse((writer.root/'code').exists());self.assertEqual(writer.leftovers(),[])
                # The launcher sends it once more, then writes the failed manifest itself.
                self.assertEqual(writer.manifest()['state'],'copying')

    def test_the_strict_check_refuses_a_dotgit_tree_and_a_commit_without_email_and_passes_zero_padded_modes(self):
        for variant,expected in (('dotgit',6),('no_email',6),('zero_padded',0)):
            with self.subTest(variant=variant):
                writer=Writer(self,variant);calls=[]
                with patch.object(box_repo.subprocess,'run',recording(calls)):code,_=writer.run()
                self.assertEqual(code,expected)
                if expected:
                    self.assertEqual((writer.manifest()['state'],writer.manifest()['reason']),('failed','refused'))
                    self.assertFalse((writer.root/'code').exists());self.assertEqual(writer.leftovers(),[])
                    self.assertIn('fsck',calls[-1][0],'refused at the fsck step, before any checkout')

    def test_an_object_the_commit_does_not_reach_is_refused(self):
        writer=Writer(self,extra=True);code,_=writer.run()
        self.assertEqual(code,6);self.assertEqual(writer.manifest()['reason'],'refused')
        self.assertFalse((writer.root/'code').exists());self.assertEqual(writer.leftovers(),[])

    def test_no_room_and_the_bounds_give_4_and_a_held_lock_gives_5(self):
        real=os.statvfs
        # Less free space than the argv need: refused before a byte is read.
        writer=Writer(self)
        with patch.object(box_repo.os,'statvfs',lambda path:SimpleNamespace(f_bavail=1,f_frsize=4096,f_files=65536,f_favail=60000)):
            code,left=writer.run()
        self.assertEqual((code,left),(4,writer.data));self.assertEqual(writer.manifest()['reason'],'room')
        # Over a bound, measured again from the copy itself, before any checkout.
        for bound,value in (('MAX_FILES',fixture.FILES-1),('MAX_FILE',4),('REPO_INODES',fixture.FILES+fixture.DIRS+1023)):
            with self.subTest(bound=bound):
                writer=Writer(self);calls=[]
                with patch.object(box_repo,bound,value),patch.object(box_repo.subprocess,'run',recording(calls)):code,_=writer.run()
                self.assertEqual(code,4);self.assertEqual(writer.manifest()['reason'],'room')
                self.assertFalse(any('reset' in command for command,_ in calls));self.assertFalse((writer.root/'code').exists())
        # A need below what this repository itself needs.
        writer=Writer(self);writer.need=len(writer.data)+4096
        self.assertEqual(writer.run()[0],4)
        # No room found while receiving (ENOSPC) leaves nothing.
        writer=Writer(self);opened=os.open
        def full(path,flags,mode=0o777,**kwargs):
            return opened('/dev/full',os.O_WRONLY|os.O_CLOEXEC) if str(path).endswith('in.bundle') else opened(path,flags,mode,**kwargs)
        with patch.object(box_repo.os,'open',full):code,_=writer.run()
        self.assertEqual(code,4);self.assertEqual(writer.leftovers(),[])
        # git's errno never reaches the writer: a git step that fails with /repo out of inodes is no room, not a refusal.
        writer=Writer(self,'dotgit');checks=[]
        def room(path):
            checks.append(path);value=real(path)
            return value if len(checks)==1 else SimpleNamespace(f_bavail=value.f_bavail,f_frsize=value.f_frsize,f_files=65536,f_favail=1)
        with patch.object(box_repo.os,'statvfs',room):code,_=writer.run()
        self.assertEqual(code,4)
        # Another writer holds the lock: nothing is read or written.
        writer=Writer(self);lock=os.open(writer.root/'.lock',os.O_CREAT|os.O_RDWR,0o600)
        import fcntl
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:
            self.assertEqual(writer.run(),(5,writer.data));self.assertEqual(box_repo.main(['fail',fixture.NAME,'main',writer.commit,'timeout'],str(writer.root)),5)
        finally:os.close(lock)
        self.assertFalse((writer.root/'manifest.json').exists())

    def test_seconds_must_be_in_range_and_the_deadline_gives_a_timeout_manifest(self):
        writer=Writer(self)
        for seconds in ('59','601','6000','1','abc',''):
            self.assertEqual(writer.run(writer.argv(seconds=seconds))[0],2,seconds)
        for bad in (writer.argv(name='example-org/widgets.git'),writer.argv(branch='-x'),writer.argv(commit='A'*40),writer.argv(bytes='0'),
                    writer.argv(need=str(256*1024**2+1)),writer.argv(digest='z'*64),writer.argv()[:-1],['fail',fixture.NAME,'main',writer.commit,'room']):
            self.assertEqual(writer.run(bad)[0],2,bad)
        self.assertFalse((writer.root/'manifest.json').exists())
        # A slowed git at the shortest writer time: past the deadline the writer stops and says so.
        clock=[1000.0];real=subprocess.run
        def slow(command,**kwargs):
            result=real(command,**kwargs)
            if 'fetch' in command:clock[0]+=61
            return result
        with patch.object(box_repo.time,'monotonic',lambda:clock[0]),patch.object(box_repo.subprocess,'run',slow):
            code,_=writer.run(writer.argv(seconds=str(box_repo.REPO_FLOOR)))
        self.assertEqual(code,7);self.assertEqual((writer.manifest()['state'],writer.manifest()['reason']),('failed','timeout'))
        self.assertEqual(writer.leftovers(),[]);self.assertFalse((writer.root/'code').exists())

    def test_ready_and_failed_read_no_stdin_and_fail_writes_only_the_manifest(self):
        writer=Writer(self);self.assertEqual(writer.run()[0],0)
        self.assertEqual(writer.run(),(0,writer.data),'a box that holds this copy reads none of it again')
        # fail never replaces a ready manifest.
        self.assertEqual(box_repo.main(['fail',fixture.NAME,'main',writer.commit,'timeout'],str(writer.root)),0)
        self.assertEqual(writer.manifest()['state'],'ready')
        for reason,code in (('room',4),('refused',6),('timeout',7),('bytes',7),('missing',7)):
            with self.subTest(reason=reason):
                failed=Writer(self)
                if reason in ('timeout','bytes','missing'):
                    self.assertEqual(box_repo.main(['fail',fixture.NAME,'main',failed.commit,reason],str(failed.root)),0)
                    self.assertEqual(sorted(p.name for p in failed.root.iterdir()),['.lock','manifest.json'],'fail writes only its manifest')
                else:box_repo.write_manifest(str(failed.root),fixture.NAME,'main',failed.commit,'failed',reason)
                self.assertEqual(failed.manifest(),{'repo':fixture.NAME,'branch':'main','commit':failed.commit,'state':'failed','reason':reason,'files':None})
                self.assertEqual(failed.run(),(code,failed.data))


SAMPLES=['example-org/widgets','a/b','example-org/.','example-org/..','example-org/widgets.git','-x/y','x/'+'y'*101,'x'*40+'/y',
         'Example-Org/Widgets_1.2','example-org/wid/gets',None,7]
BRANCHES=['main','release/1.2','a..b','a//b','-x','/x','.x','x/','x.','x.lock','x@{1}','x y','x'*255,'x'*256,'feature/A_b-c.d',None]


class ParityTests(unittest.TestCase):
    """One copy, one set of numbers: github.py, the fetcher, the writer, the launcher and the store must agree."""
    def test_the_python_sides_agree(self):
        modules=(github,repo_fetch,box_repo)
        for name in ('MAX_BUNDLE','MAX_FILES','MAX_FILE','REPO_ROOM','REPO_INODES','REPO_RESERVE','PAGE'):
            self.assertEqual({getattr(module,name) for module in modules},{getattr(github,name)},name)
        self.assertEqual((github.MAX_REPOS,github.MAX_BUNDLE,github.MAX_FILES,github.MAX_FILE,github.REPO_ROOM,github.REPO_INODES,github.REPO_RESERVE,github.PAGE),
                         (10,67108864,50000,67108864,268435456,65536,8*1024**2,4096))
        self.assertEqual((launcher.MAX_BUNDLE,launcher.REPO_ROOM,launcher.REPO_INODES),(github.MAX_BUNDLE,github.REPO_ROOM,github.REPO_INODES))
        self.assertEqual(repo_fetch.FSCK_IGNORE,box_repo.FSCK_IGNORE);self.assertEqual(box_repo.FSCK_IGNORE,('zeroPaddedFilemode',))
        self.assertEqual((box_repo.WRITER_SECONDS,box_repo.REPO_FLOOR),(launcher.WRITER_SECONDS,launcher.REPO_FLOOR))
        self.assertEqual((launcher.WRITER_SECONDS,launcher.REPO_MARGIN,launcher.REPO_FLOOR,launcher.REPO_GRACE,launcher.REPO_TRIES,launcher.REPO_MEMORY),
                         (600,60,60,15,2,512*1024**2))
        self.assertEqual((github.FETCH_SECONDS,github.FETCH_UID,launcher.REPO_UID),(150,65530,65531))
        self.assertLess(repo_fetch.SECONDS,github.FETCH_SECONDS,'the fetcher ends its work before the watchdog removes it')
        self.assertEqual(launcher.REPO_TMPFS,'rw,noexec,nosuid,nodev,size=256m,nr_inodes=65536,uid=65531,gid=65531,mode=0755')
        for name in ('NAME','BRANCH','COMMIT'):
            self.assertEqual({getattr(module,name).pattern for module in modules},{getattr(github,name).pattern},name)
        self.assertEqual((launcher.REPO_NAME.pattern,launcher.REPO_BRANCH.pattern,launcher.COMMIT.pattern,launcher.DIGEST.pattern),
                         (github.NAME.pattern,github.BRANCH.pattern,github.COMMIT.pattern,github.DIGEST.pattern))
        self.assertEqual(box_repo.DIGEST.pattern,github.DIGEST.pattern)
        for sample in SAMPLES:
            self.assertEqual({bool(module.repo_name(sample)) for module in (*modules,launcher)},{bool(github.repo_name(sample))},sample)
        for sample in BRANCHES:
            self.assertEqual({bool(module.repo_branch(sample)) for module in (*modules,launcher)},{bool(github.repo_branch(sample))},sample)
        self.assertEqual([github.repo_name(s) for s in SAMPLES],[True,True,False,False,False,False,False,False,True,False,False,False])
        self.assertEqual([github.repo_branch(s) for s in BRANCHES],[True,True,False,False,False,False,False,False,False,False,False,False,True,False,True,False])
        for values in ((1,0,0,0),(64*1024**2,184*1024**2,4096,10**6),(5000,4096*3,4096+128*5,40)):
            self.assertEqual({module.need(*values) for module in modules},{github.need(*values)})
            bundle,pages,index,objects=values
            self.assertEqual(github.need(*values),bundle+max(bundle,pages+index)+4096+32*objects+8*1024**2)
        self.assertEqual(inspect.getsource(repo_fetch.measure),inspect.getsource(box_repo.measure),'the fetcher and the writer measure a tip alike')

    def test_the_writer_time_fits_every_run(self):
        self.assertGreaterEqual(launcher.REPO_MARGIN,job_box.MARGIN+job_box.FLOOR,'a copy lands while box tools still start')
        source=(ROOT/'src/stores/background-jobs.ts').read_text()
        constants=dict(re.findall(r'\b(HARD_GRACE_MS|RELAUNCH_MS)=(\d+)',source))
        # Every run starts at least RELAUNCH_MS+HARD_GRACE_MS before hard; 60 s of that is the start latency budget.
        self.assertGreaterEqual((int(constants['RELAUNCH_MS'])+int(constants['HARD_GRACE_MS']))/1000-launcher.REPO_MARGIN-60,240)

    def test_the_store_has_the_same_numbers_and_patterns(self):
        source=(ROOT/'src/stores/background-jobs.ts').read_text()
        numbers=re.search(r'export const MAX_REPOS=(\d+),MAX_BUNDLE=(\d+),MAX_FILES=(\d+),REPO_ROOM=(\d+);',source)
        if numbers is None:self.skipTest('the store side of ADR-0209 is not in this checkout yet')
        self.assertEqual(tuple(map(int,numbers.groups())),(github.MAX_REPOS,github.MAX_BUNDLE,github.MAX_FILES,github.REPO_ROOM))
        patterns=dict(re.findall(r'\b(REPO_NAME|COMMIT|DIGEST|COPY_ID)=/\^(.+?)\$/',source))
        self.assertEqual({key:value.replace('\\/','/') for key,value in patterns.items()},
                         {'REPO_NAME':github.NAME.pattern,'COMMIT':github.COMMIT.pattern,'DIGEST':github.DIGEST.pattern,'COPY_ID':github.COPY_ID.pattern})
        self.assertIn("/^[A-Za-z0-9._\\/-]{1,255}$/",source,'the store checks the same branch class')
        self.assertIn("!/\\.\\.|\\/\\/|^[-\\/.]|[\\/.]$|\\.lock$/",source,'and the same branch rules')


if __name__=='__main__':unittest.main()
