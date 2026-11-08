"""Copies a job's pinned GitHub bundle into the sealed box's /repo; runs there as uid 65531 (ADR-0209).

Usage: python3 -I /opt/box/box_repo.py copy <name> <branch> <commit> <bytes> <need> <sha256> <seconds>, with the
bundle on stdin, or fail <name> <branch> <commit> <missing|timeout|bytes>.

The copy lands whole or not at all: git fetches the bundle into a stage, the history passes a strict fsck and holds
only objects the commit reaches, the checkout is walked, and then `code` is renamed into place. The manifest is
written last. Box commands (uid 65532) can read everything but change nothing and cannot hold the lock.
Exit codes: 0 ready, 2 bad argv, 3 bytes mismatch, 4 no room or over a limit, 5 busy, 6 refused by git, fsck or the
walk, 7 past the deadline or an earlier failure for time, bytes or a missing bundle.
"""
import errno
import fcntl
import hashlib
import json
import os
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

# The bounds of a copy (ADR-0209 §0). Same numbers and patterns as github.py, repo_fetch.py, security_launcher.py and
# background-jobs.ts; a parity test reads them.
MAX_BUNDLE=64*1024**2
MAX_FILES=50000
MAX_FILE=64*1024**2
REPO_ROOM=256*1024**2
REPO_INODES=65536
REPO_RESERVE=8*1024**2
PAGE=4096
WRITER_SECONDS=600
REPO_FLOOR=60
FSCK_IGNORE=('zeroPaddedFilemode',)
NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')
BRANCH=re.compile(r'[A-Za-z0-9._/-]{1,255}')
COMMIT=re.compile(r'[a-f0-9]{40}')
DIGEST=re.compile(r'[a-f0-9]{64}')

READY,BAD_ARGV,BYTES,ROOM,BUSY,REFUSED,LATE=0,2,3,4,5,6,7
# The exit code an earlier failure gives, by its manifest reason.
REASONS={'room':ROOM,'refused':REFUSED,'timeout':LATE,'bytes':LATE,'missing':LATE}


class Stop(Exception):
    """Ends the writer with an exit code and, with a reason, a failed manifest."""
    def __init__(self,code,reason=None):super().__init__(code);self.code=code;self.reason=reason


def repo_name(value):
    return type(value) is str and bool(NAME.fullmatch(value)) and value.split('/')[1] not in ('.','..') and not value.endswith('.git')


def repo_branch(value):
    # '@{' needs no check: neither character is in the class.
    return type(value) is str and bool(BRANCH.fullmatch(value)) and not re.search(r'\.\.|//|^[-/.]|[/.]$|\.lock$',value)


def need(bundle,pages,index,objects):
    """The bytes a copy needs in /repo: the bundle and the pack it becomes, or the pack and the checkout, plus the
    pack's .idx and .rev, and the reserve."""
    return bundle+max(bundle,pages+index)+4096+32*objects+REPO_RESERVE


def measure(listing):
    """files, dirs, largest, pages and index of a tip, from `git ls-tree -r -l -z --full-tree` output."""
    files=largest=pages=gitlinks=0;index=4096;folders=set()
    for entry in listing.split(b'\0'):
        if not entry:continue
        meta,path=entry.split(b'\t',1);_,kind,_,size=meta.split()
        index+=128+2*len(path);parts=path.split(b'/')
        folders.update(b'/'.join(parts[:n]) for n in range(1,len(parts)))
        # A gitlink becomes an empty folder.
        if kind==b'commit':gitlinks+=1;continue
        if kind!=b'blob':raise ValueError('unexpected_tree_entry')
        size=int(size);files+=1;largest=max(largest,size)
        # tmpfs takes a whole page for every file that is not empty.
        if size:pages+=-(-size//PAGE)*PAGE
    return {'files':files,'dirs':len(folders)+gitlinks,'largest':largest,'pages':pages,'index':index}


# Symlinks become small files, nothing runs, and git shares the box's one CPU with the job's commands. There is no
# transfer fsck: its verdict differs between git versions, so step 7 runs one explicit fsck instead.
CONFIG=[('core.symlinks','false'),('core.hooksPath','/dev/null'),('core.fsmonitor','false'),
        *(('fsck.'+name,'ignore') for name in FSCK_IGNORE),('protocol.allow','never'),('protocol.file.allow','always'),
        ('gc.auto','0'),('maintenance.auto','false'),('pack.threads','1'),('index.threads','1'),('checkout.workers','1'),
        ('core.deltaBaseCacheLimit','32m')]


def environment(stage):
    """An explicit git environment, never inherited: exec gives the writer the box's HOME=/work."""
    env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','TMPDIR':stage,'LANG':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1',
         'GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':str(len(CONFIG))}
    for number,(key,value) in enumerate(CONFIG):env['GIT_CONFIG_KEY_%d'%number]=key;env['GIT_CONFIG_VALUE_%d'%number]=value
    return env


def read_manifest(root):
    try:
        with open(os.path.join(root,'manifest.json'),'rb',opener=lambda path,flags:os.open(path,flags|os.O_NOFOLLOW)) as file:
            value=json.loads(file.read(65536))
        return value if isinstance(value,dict) else None
    except (OSError,ValueError):return None


def write_manifest(root,name,branch,commit,state,reason=None,files=None):
    """Replaces the manifest whole, read-only, as box_put does."""
    data=json.dumps({'repo':name,'branch':branch,'commit':commit,'state':state,'reason':reason,'files':files}).encode()
    temp=os.path.join(root,'.manifest.'+os.urandom(8).hex())
    try:
        with os.fdopen(os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o444),'wb') as file:file.write(data)
        os.replace(temp,os.path.join(root,'manifest.json'))
    finally:
        try:os.unlink(temp)
        except FileNotFoundError:pass


def remove(path):
    if os.path.isdir(path) and not os.path.islink(path):shutil.rmtree(path,ignore_errors=True)
    else:
        try:os.unlink(path)
        except FileNotFoundError:pass


def receive(stdin,path,size,expected,left):
    """The bundle from stdin, kept only if every byte arrived, as box_put keeps a part."""
    digest=hashlib.sha256();count=0
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o400),'wb') as file:
        while True:
            if not select.select([stdin],[],[],left())[0]:raise Stop(LATE,'timeout')
            try:chunk=os.read(stdin,min(1<<20,size+1-count) or 1)
            except OSError:raise Stop(BYTES) from None
            if not chunk:break
            count+=len(chunk)
            if count>size:raise Stop(BYTES)
            digest.update(chunk);file.write(chunk)
    if count!=size or digest.hexdigest()!=expected:raise Stop(BYTES)


def walk(top,left):
    """Only regular files and folders, none setuid or setgid."""
    folders=[top];seen=0
    while folders:
        folder=folders.pop()
        if os.lstat(folder).st_mode&(stat.S_ISUID|stat.S_ISGID):raise Stop(REFUSED,'refused')
        with os.scandir(folder) as entries:
            for entry in entries:
                mode=entry.stat(follow_symlinks=False).st_mode
                if mode&(stat.S_ISUID|stat.S_ISGID):raise Stop(REFUSED,'refused')
                if stat.S_ISDIR(mode):folders.append(entry.path)
                elif not stat.S_ISREG(mode):raise Stop(REFUSED,'refused')
                seen+=1
                if not seen%1024:left()


def copy(root,stdin,name,branch,commit,size,limit,digest,seconds):
    deadline=time.monotonic()+seconds;stage=None
    def left():
        remaining=deadline-time.monotonic()
        if remaining<=0:raise Stop(LATE,'timeout')
        return remaining
    def failed(returncode):
        # git's errno never reaches the writer: a step that failed for want of room shows in /repo's free space.
        room=os.statvfs(root)
        if returncode==-signal.SIGXFSZ or room.f_files and room.f_favail<1024 or room.f_bavail*room.f_frsize<REPO_RESERVE:
            return Stop(ROOM,'room')
        return Stop(REFUSED,'refused')
    def git(*args,output=False):
        try:
            result=subprocess.run(['git',*args],env=env,cwd=stage,stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE if output else subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=left())
        except subprocess.TimeoutExpired:raise Stop(LATE,'timeout') from None
        if result.returncode:raise failed(result.returncode)
        return result.stdout
    try:
        # 3. What an earlier writer left, and what the job sees while this copy runs.
        with os.scandir(root) as entries:
            for entry in entries:
                if entry.name.startswith(('.stage-','.manifest.')):remove(entry.path)
        remove(os.path.join(root,'code'))
        write_manifest(root,name,branch,commit,'copying')
        # 4. Room for the copy as github.py counted it.
        room=os.statvfs(root)
        if room.f_bavail*room.f_frsize<limit:raise Stop(ROOM,'room')
        # 5. Every byte, and only those.
        stage=os.path.join(root,'.stage-'+os.urandom(8).hex());os.mkdir(stage,0o700);env=environment(stage)
        code=os.path.join(stage,'code');ref='refs/heads/'+branch
        receive(stdin,os.path.join(stage,'in.bundle'),size,digest,left)
        # 6. Fetched, not cloned: a clone would write a remote.
        git('init','-q','--template=','-b',branch,code)
        git('-C',code,'fetch','-q','--update-head-ok','--no-tags','--no-write-fetch-head','../in.bundle','+%s:%s'%(ref,ref))
        if git('-C',code,'rev-parse','--verify','--quiet',ref,output=True).strip().decode()!=commit:raise Stop(REFUSED,'refused')
        # 7. The same strict check as the fetcher's, then only objects the commit reaches: fsck passes the others.
        git('-C',code,'fsck','--strict','--no-dangling','--no-reflogs','--no-progress')
        counts=dict(line.split(': ',1) for line in git('-C',code,'count-objects','-v',output=True).decode().splitlines() if ': ' in line)
        stored=int(counts.get('count','0'))+int(counts.get('in-pack','0'))
        if stored!=int(git('-C',code,'rev-list','--objects','--count',ref,output=True)):raise Stop(REFUSED,'refused')
        # 8. The bounds again, from this repository itself, before any checkout.
        os.unlink(os.path.join(stage,'in.bundle'))
        try:tip=measure(git('-C',code,'ls-tree','-r','-l','-z','--full-tree',commit,output=True))
        except ValueError:raise Stop(REFUSED,'refused') from None
        if tip['files']>MAX_FILES or tip['largest']>MAX_FILE or tip['files']+tip['dirs']+1024>REPO_INODES \
                or need(size,tip['pages'],tip['index'],stored)>limit:raise Stop(ROOM,'room')
        # 9-11. The checkout, its files, and no remote.
        git('-C',code,'reset','-q','--hard')
        walk(code,left)
        names=git('config','--file',os.path.join(code,'.git/config'),'--name-only','--list',output=True).decode().splitlines()
        if any(key.startswith('remote.') for key in names):raise Stop(REFUSED,'refused')
        # 12-13. Into place whole, then the manifest last.
        left();os.chmod(code,0o755);os.rename(code,os.path.join(root,'code'))
        remove(stage);stage=None
        write_manifest(root,name,branch,commit,'ready',files=tip['files'])
        return READY
    except Stop as stop:
        if stop.reason:
            try:write_manifest(root,name,branch,commit,'failed',stop.reason)
            except OSError:pass
        return stop.code
    except OSError as error:
        reason,code=('room',ROOM) if error.errno in (errno.ENOSPC,errno.EDQUOT,errno.EFBIG) else ('refused',REFUSED)
        try:write_manifest(root,name,branch,commit,'failed',reason)
        except OSError:pass
        return code
    finally:
        if stage:remove(stage)


def main(argv,root='/repo',stdin=0):
    # docker exec starts with umask 0000; box commands (uid 65532) must not change these files.
    os.umask(0o022)
    command,*rest=argv or ['']
    if command=='copy' and len(rest)==7:
        name,branch,commit,size,limit,digest,seconds=rest
        if not (re.fullmatch(r'[0-9]{1,9}',size) and re.fullmatch(r'[0-9]{1,9}',limit) and DIGEST.fullmatch(digest)
                and re.fullmatch(r'[0-9]{2,3}',seconds)):return BAD_ARGV
        size,limit,seconds=int(size),int(limit),int(seconds)
        if not (0<size<=MAX_BUNDLE and 0<limit<=REPO_ROOM and REPO_FLOOR<=seconds<=WRITER_SECONDS):return BAD_ARGV
    elif command=='fail' and len(rest)==4 and rest[3] in ('missing','timeout','bytes'):name,branch,commit,reason=rest
    else:return BAD_ARGV
    if not (repo_name(name) and repo_branch(branch) and COMMIT.fullmatch(commit)):return BAD_ARGV
    # 1. One writer at a time. The lock is 0600 in a 0755 folder: box commands can neither open nor create it.
    lock=os.open(os.path.join(root,'.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return BUSY
        current=read_manifest(root) or {}
        if command=='fail':
            if current.get('state')!='ready':write_manifest(root,name,branch,commit,'failed',reason)
            return READY
        # 2. A box that already holds this copy, or already failed it, reads no stdin.
        if (current.get('repo'),current.get('branch'),current.get('commit'))==(name,branch,commit):
            if current.get('state')=='ready':return READY
            if current.get('state')=='failed':return REASONS.get(current.get('reason'),LATE)
        return copy(root,stdin,name,branch,commit,size,limit,digest,seconds)
    finally:os.close(lock)


if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
