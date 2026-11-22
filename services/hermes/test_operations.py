import contextlib
import errno
import hashlib
import io
import json
import os
import socket
import stat
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from tools.operations.installation import operations
from tools.operations.installation.backup_schedule import health,read_health
from tools.operations.installation.operations import sha,validate_snapshot,backup,restore,fingerprints,honcho_state,extract_state,BackupError,TABLES,HONCHO_STATE

WORKSPACE='hermes/profiles/owner/workspace'
RETIRED='hermes/retired-profiles/old-1700000000/workspace'
NOTHING_SCHEDULED={'NOCHEH_BACKUP_SCHEDULE':'off','NOCHEH_BACKUP_TIME':'04:00','NOCHEH_BACKUP_TIME_ZONE':'UTC','NOCHEH_BACKUP_KEEP':'7'}


def new_state(root):
    state=root/'state';state.mkdir();(state/'.env').write_text('TELEGRAM_ENABLED=false\n')
    for name in ('files','spool','hermes'):(state/name).mkdir()
    return state


@contextlib.contextmanager
def two_stores(commands,dump=None,running='nocheh-app'):
    """A two-store backup with Compose and the database replaced; `dump` stands for pg_dump."""
    def run(command,**kwargs):
        commands.append(command)
        if 'pg_dump' in command:(dump or (lambda output:output.write(b'synthetic database dump')))(kwargs['stdout'])
    with patch('tools.operations.installation.operations.compose',return_value=['fixture']),\
         patch('tools.operations.installation.operations.environment',return_value={}),\
         patch('tools.operations.installation.operations.subprocess.check_output',side_effect=[running,'fixture-revision']),\
         patch('tools.operations.installation.operations.fingerprints',return_value={'events':'hash'}),\
         patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
         patch('tools.operations.workflows.workflow_worker.running',return_value=False):
        yield


def archive_members(snapshot):
    with tarfile.open(snapshot/'state.tar.gz','r:gz') as tar:
        return {member.name[len('state/'):]:member for member in tar}


def link_snapshot(root,links,members,files=None):
    """A snapshot whose archive holds `members` (name, type, link target or bytes) and whose manifest lists `links`."""
    (root/'archive.dump').write_bytes(b'synthetic dump')
    listed=dict(files or {})
    with tarfile.open(root/'state.tar.gz','w:gz') as tar:
        for name,kind,value in members:
            info=tarfile.TarInfo('state/'+name);info.type=kind
            if kind==tarfile.REGTYPE:
                info.size=len(value);tar.addfile(info,io.BytesIO(value))
                listed.setdefault(name,{'sha256':hashlib.sha256(value).hexdigest(),'size':len(value)})
            else:
                info.linkname=value or '';tar.addfile(info)
    manifest={'version':1,'dump_sha256':sha(root/'archive.dump'),'state_sha256':sha(root/'state.tar.gz'),'files':listed,'links':links}
    (root/'manifest.json').write_text(json.dumps(manifest));return manifest


class SnapshotTests(unittest.TestCase):
    def snapshot(self,root,name='state/files/example',kind=None):
        raw=b'unchanged Aws \xf0\x9f\x98\x83\r\n  '
        (root/'archive.dump').write_bytes(b'synthetic dump')
        original=root/'original';original.write_bytes(raw)
        with tarfile.open(root/'state.tar.gz','w:gz') as tar:
            info=tarfile.TarInfo(name);info.size=len(raw)
            if kind: info.type=kind;info.linkname='/outside';info.size=0
            tar.addfile(info,io.BytesIO(raw) if not kind else None)
        manifest={'version':1,'dump_sha256':sha(root/'archive.dump'),'state_sha256':sha(root/'state.tar.gz'),
                  'files':{'files/example':{'sha256':sha(original),'size':len(raw)}}}
        (root/'manifest.json').write_text(json.dumps(manifest));return manifest

    def test_exact_snapshot_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.snapshot(root)
            self.assertEqual(validate_snapshot(root),manifest)
            (root/'archive.dump').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError,'checksum'): validate_snapshot(root)

    def test_reject_traversal_and_links_even_with_matching_container_hash(self):
        for name,kind in [('state/../../outside',None),('state/files/example',tarfile.SYMTYPE),('/state/files/example',None)]:
            with self.subTest(name=name,kind=kind),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.snapshot(root,name,kind)
                with self.assertRaisesRegex(ValueError,'Unsafe'): validate_snapshot(root)

    def test_reject_missing_manifest_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.snapshot(root)
            manifest['files']['files/missing']={'sha256':'0'*64,'size':0}
            (root/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'Incomplete'): validate_snapshot(root)

    def test_backup_preserves_import_approval_and_native_review_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state';state.mkdir();(state/'.env').write_text('TELEGRAM_ENABLED=false\n')
            for name in ('files','spool','hermes','admin/jobs/fixture','admin/dashboard/home'):(state/name).mkdir(parents=True,exist_ok=True)
            (state/'admin/dashboard/home/config.yaml').write_text('dashboard: {font: system-mono}\n')
            job=state/'admin/jobs/fixture/job.json';job.write_text('{"review_approved":true,"state":"cancelled"}')
            receipt=state/'hermes/review-receipt';receipt.write_text('ambiguous')
            cache=state/'hermes/profiles/fixture/.cache/uv';cache.mkdir(parents=True)
            (cache/'wheel-link').symlink_to('/not-read-by-backup')
            commands=[]
            def run(command,**kwargs):
                commands.append(command)
                if 'pg_dump' in command:kwargs['stdout'].write(b'synthetic database dump')
            with patch('tools.operations.installation.operations.compose',return_value=['fixture']),patch('tools.operations.installation.operations.environment',return_value={}),\
                 patch('tools.operations.installation.operations.subprocess.check_output',side_effect=['nocheh-app','fixture-revision']),\
                 patch('tools.operations.installation.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
                 patch('tools.operations.workflows.workflow_worker.running',return_value=True),\
                 patch('tools.operations.workflows.workflow_worker.stop') as stop_host,patch('tools.operations.workflows.workflow_worker.resume_existing') as start_host:
                backup(state,root/'backup')
                stop_host.assert_called_once_with(state,wait=True);start_host.assert_called_once_with(state)
            self.assertIn(['fixture','start','--wait','--wait-timeout','300','nocheh-app'],commands)
            self.assertFalse(any('up' in command for command in commands))
            manifest=validate_snapshot(root/'backup')
            self.assertEqual(manifest['version'],3)
            self.assertIn('admin/dashboard/home/config.yaml',manifest['files'])
            self.assertEqual(manifest['files']['admin/jobs/fixture/job.json']['sha256'],sha(job))
            self.assertEqual(manifest['files']['hermes/review-receipt']['sha256'],sha(receipt))
            self.assertIn('memory_review_jobs',manifest['tables'])
            self.assertIn('memory_shares',manifest['tables'])
            self.assertIn('honcho_context_cache',manifest['tables'])
            self.assertEqual(manifest['excluded_rebuildable_caches'],['hermes/profiles/fixture/.cache/uv'])
            self.assertFalse(any('.cache/uv' in name for name in manifest['files']))
            (state/'hermes/unknown-link').symlink_to('/not-read-by-backup')
            with patch('tools.operations.installation.operations.compose',return_value=['fixture']),patch('tools.operations.installation.operations.environment',return_value={}),\
                 patch('tools.operations.installation.operations.subprocess.check_output',side_effect=['','fixture-revision']),\
                 patch('tools.operations.installation.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
                 patch('tools.operations.workflows.workflow_worker.running',return_value=False):
                with self.assertRaisesRegex(BackupError,'backup_unsupported_link') as raised:backup(state,root/'rejected-backup')
            self.assertEqual(raised.exception.path,'hermes/unknown-link')
            self.assertEqual([path.name for path in root.iterdir() if path.name.startswith('.backup-')],[],'a failed backup leaves no stage')
            self.assertFalse((root/'rejected-backup').exists())
            self.assertEqual({key:read_health(state)[key] for key in ('state','failed_in_row','error','path')},
                             {'state':'failed','failed_in_row':1,'error':'backup_unsupported_link','path':'hermes/unknown-link'})

    def test_honcho_backup_needs_every_owned_state_file(self):
        with tempfile.TemporaryDirectory() as folder:
            memory=Path(folder)
            for name in HONCHO_STATE:(memory/name).write_text('synthetic')
            # The build file lives in the Honcho source checkout, so state holds only the owned files.
            self.assertEqual(honcho_state(memory),list(HONCHO_STATE))
            (memory/'database_password').unlink();(memory/'database_password').symlink_to(memory/'honcho.env')
            with self.assertRaisesRegex(ValueError,'honcho_backup_state_missing'):honcho_state(memory)
            (memory/'database_password').unlink()
            with self.assertRaisesRegex(ValueError,'honcho_backup_state_missing'):honcho_state(memory)

    def test_restore_fingerprint_table_names_are_allowlisted(self):
        with patch('tools.operations.installation.operations.subprocess.Popen') as process:
            with self.assertRaises(ValueError):fingerprints([],{},['events; DROP TABLE events'])
            process.assert_not_called()

    def run_backup_with_restart(self,folder,start_results,clock_step=0):
        """A backup whose service starts return `start_results` in turn (an exception fails that try)."""
        root=Path(folder);state=root/'state';state.mkdir()
        (state/'.env').write_text('TELEGRAM_ENABLED=false\n')
        for name in ('files','spool','hermes'):(state/name).mkdir()
        commands=[];results=list(start_results);clock=[0.0]
        def run(command,**kwargs):
            commands.append(command)
            if 'pg_dump' in command:kwargs['stdout'].write(b'synthetic database dump')
            if 'start' in command:
                clock[0]+=clock_step
                result=results.pop(0) if results else None
                if isinstance(result,BaseException):raise result
        def sleep(seconds):clock[0]+=seconds
        with patch('tools.operations.installation.operations.compose',return_value=['fixture']),\
             patch('tools.operations.installation.operations.environment',return_value={}),\
             patch('tools.operations.installation.operations.subprocess.check_output',side_effect=['nocheh-app\nhermes','fixture-revision']),\
             patch('tools.operations.installation.operations.fingerprints',return_value={}),\
             patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
             patch('tools.operations.installation.operations.time.monotonic',side_effect=lambda:clock[0]),\
             patch('tools.operations.installation.operations.time.sleep',side_effect=sleep),\
             patch('tools.operations.workflows.workflow_worker.running',return_value=True),\
             patch('tools.operations.workflows.workflow_worker.stop'),\
             patch('tools.operations.workflows.workflow_worker.resume_existing') as start_host,\
             contextlib.redirect_stderr(io.StringIO()):
            try:backup(state,root/'backup');raised=None
            except Exception as error:raised=error
        starts=[command for command in commands if 'start' in command]
        self.assertFalse(any('up' in command for command in commands))
        self.assertEqual(validate_snapshot(root/'backup')['version'],3)
        return raised,starts,start_host

    def test_a_service_still_settling_is_started_again_until_healthy(self):
        # Compose gives up on a service that turns unhealthy while it waits for store setup; a later try finds it healthy.
        unhealthy=subprocess.CalledProcessError(1,'start')
        with tempfile.TemporaryDirectory() as folder:
            raised,starts,start_host=self.run_backup_with_restart(folder,[unhealthy,unhealthy,None])
        self.assertIsNone(raised)
        self.assertEqual(starts,[['fixture','start','--wait','--wait-timeout','300','hermes','nocheh-app']]*3)
        start_host.assert_called_once()

    def test_backup_resume_failure_preserves_snapshot_and_still_starts_the_workflow_host(self):
        unhealthy=subprocess.CalledProcessError(1,'start')
        with tempfile.TemporaryDirectory() as folder:
            raised,starts,start_host=self.run_backup_with_restart(folder,[unhealthy]*1000,clock_step=60)
        self.assertIs(raised,unhealthy)
        # Tried again until the patience ran out, never forever.
        self.assertGreater(len(starts),1)
        self.assertLessEqual(len(starts),operations.RESTART_PATIENCE//60+1)
        # A failed start never keeps the workflow host stopped.
        start_host.assert_called_once()

    def test_restore_holds_all_executors_before_starting_services(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);snapshot=root/'snapshot';snapshot.mkdir();state=root/'restored'
            (snapshot/'archive.dump').write_bytes(b'dump')
            # Every real snapshot holds the dashboard home's config, so restore extracts into admin/dashboard/home.
            members={'hermes/auth.json':b'{"synthetic":"login"}','admin/dashboard/home/config.yaml':b'model: example\n',
                     'spool/agent-turns/example.json':b'{}','files/example':b'synthetic'}
            with tarfile.open(snapshot/'state.tar.gz','w:gz') as tar:
                for name,raw in members.items():
                    info=tarfile.TarInfo('state/'+name);info.size=len(raw);tar.addfile(info,io.BytesIO(raw))
            manifest={'version':1,'tables':{'events':'exact-hash'},'files':{name:{} for name in members}}
            starts=[]
            def run(command,**kwargs):
                if command[:3]==['docker','volume','inspect']:return SimpleNamespace(returncode=1)
                if 'up' in command:
                    starts.append(command)
                    for name in ('spool/.restore-inactive','workflows/inactive','hermes/scheduler-inactive','admin/tools/inactive','hermes/auth.restore-pending.json'):
                        self.assertTrue((state/name).is_file(),name)
                    # Hermes's two mounted folders exist before any service starts, so Docker never makes them as root.
                    # Their parents are 0700 too, also those extraction reaches first: admin/dashboard holds the token.
                    for name in ('files','spool','spool/agent-turns','hermes','admin','admin/dashboard','admin/dashboard/home'):
                        self.assertEqual((state/name).stat().st_mode&0o777,0o700,name)
                    self.assertFalse((state/'hermes/auth.json').exists())
                    self.assertIn("TELEGRAM_ENABLED='false'",(state/'.env').read_text())
                    self.assertNotIn("NOCHEH_WORKFLOWS_ENABLED",(state/'.env').read_text())
                    from tools.operations.installation.configuration import read_env
                    restored=read_env(state/'.env')
                    self.assertEqual(restored['NOCHEH_HONCHO_ENABLED'],'false')
                    self.assertEqual(restored['NOCHEH_HONCHO_STATE_DIR'],str(state/'honcho'))
                    self.assertEqual(restored['NOCHEH_HONCHO_DATABASE_VOLUME'],'nocheh-test-restore_honcho_database')
                    self.assertEqual(restored['NOCHEH_HONCHO_REDIS_VOLUME'],'nocheh-test-restore_honcho_redis')
                    # Its own name, so its off-site copies never mix with a workspace's, and this checkout's images.
                    self.assertEqual((restored['NOCHEH_WORKSPACE'],restored['NOCHEH_IMAGES']),('test-restore','nocheh'))
                return SimpleNamespace(returncode=0)
            with patch('tools.operations.installation.operations.validate_snapshot',return_value=manifest),\
                 patch('tools.operations.installation.operations.initialize',return_value={'TELEGRAM_ENABLED':'true','NOCHEH_HONCHO_ENABLED':'true','NOCHEH_HONCHO_STATE_DIR':'/live/memory','NOCHEH_HONCHO_DATABASE_VOLUME':'live-db','NOCHEH_HONCHO_REDIS_VOLUME':'live-cache'}),\
                 patch('tools.operations.installation.operations.compose',return_value=['fixture']),\
                 patch('tools.operations.installation.operations.environment',return_value={}),\
                 patch('tools.operations.installation.operations.fingerprints',return_value=manifest['tables']),\
                 patch('tools.operations.installation.workspaces.listed',return_value=[]),\
                 patch('tools.operations.installation.workspaces.checkout_settings',return_value=None),\
                 patch('tools.operations.installation.operations.subprocess.run',side_effect=run):
                mask=os.umask(0o022)
                try:result=restore(snapshot,state,'nocheh-test-restore',18980)
                finally:os.umask(mask)
                # A restore never takes a workspace's name, so never its off-site folder either.
                with self.assertRaisesRegex(ValueError,'is a workspace'):restore(snapshot,root/'state-personal','nocheh-personal',18990)
            self.assertEqual(len(starts),2);self.assertFalse(result['executors_active'])
            self.assertFalse(result['telegram_enabled']);self.assertFalse(result['hermes_login_activated'])


class WorkspaceLinkTests(unittest.TestCase):
    """Links and special files an approved command leaves in a workspace never stop a backup (ADR-0251)."""
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);self.root=Path(folder.name)

    def test_links_are_kept_special_files_skipped_and_hard_links_copied(self):
        state=new_state(self.root);workspace=state/WORKSPACE;(workspace/'project').mkdir(parents=True)
        (workspace/'project/notes.txt').write_text('synthetic upload\n')
        (workspace/'current').symlink_to('project')
        (workspace/'venv/bin').mkdir(parents=True);(workspace/'venv/bin/python').symlink_to('/opt/example/bin/python')
        # A workspace folder named like the plugin link is still the command's own link.
        (workspace/'tool/plugins').mkdir(parents=True);(workspace/'tool/plugins/nocheh').symlink_to('../..')
        os.mkfifo(workspace/'pipe');os.mknod(workspace/'socket',stat.S_IFSOCK|0o600)
        (workspace/'first.txt').write_bytes(b'same bytes');os.link(workspace/'first.txt',workspace/'second.txt')
        if os.geteuid()==0:os.mknod(workspace/'device',stat.S_IFCHR|0o600,os.makedev(1,3))
        outside=self.root/'outside';outside.mkdir();os.chmod(outside,0o755)
        retired=state/RETIRED;retired.mkdir(parents=True);(retired/'data').symlink_to(outside)
        (state/'hermes/profiles/owner/plugins').mkdir(parents=True);(state/'hermes/profiles/owner/plugins/nocheh').symlink_to('/opt/example/plugin')
        os.mkfifo(state/'spool/stray-pipe')
        # The backup's own job, still running inside the snapshot it makes.
        (state/'admin/jobs/fixture').mkdir(parents=True);(state/'admin/jobs/fixture/job.json').write_text('{"kind":"operations.backup","state":"running"}')
        with two_stores([]):result=backup(state,self.root/'backup')
        self.assertEqual(result['status'],'backed_up')
        manifest=validate_snapshot(self.root/'backup')
        self.assertEqual(manifest['links'],{WORKSPACE+'/current':'project',WORKSPACE+'/venv/bin/python':'/opt/example/bin/python',
                                            WORKSPACE+'/tool/plugins/nocheh':'../..',RETIRED+'/data':str(outside)})
        self.assertEqual(manifest['recreated_plugin_links'],['hermes/profiles/owner/plugins/nocheh'])
        special=[WORKSPACE+'/pipe',WORKSPACE+'/socket','spool/stray-pipe']+([WORKSPACE+'/device'] if os.geteuid()==0 else [])
        self.assertEqual(sorted(manifest['skipped_special_files']),sorted(special))
        members=archive_members(self.root/'backup')
        for name in ('first.txt','second.txt'):
            self.assertEqual(members[WORKSPACE+'/'+name].type,tarfile.REGTYPE,'a second name for a file is a plain copy')
        self.assertEqual(manifest['files'][WORKSPACE+'/first.txt'],manifest['files'][WORKSPACE+'/second.txt'])
        self.assertEqual((members[WORKSPACE+'/current'].type,members[WORKSPACE+'/current'].linkname),(tarfile.SYMTYPE,'project'))
        self.assertEqual(manifest['unreadable'],[])
        self.assertEqual(health(state,NOTHING_SCHEDULED)['failed'],0)
        restored=self.root/'restored';restored.mkdir()
        extract_state(self.root/'backup',restored)
        self.assertEqual(os.readlink(restored/WORKSPACE/'current'),'project')
        self.assertEqual(os.readlink(restored/RETIRED/'data'),str(outside),'a folder that holds only a link is made for it')
        self.assertEqual((restored/WORKSPACE/'project/notes.txt').read_text(),'synthetic upload\n')
        self.assertFalse((restored/WORKSPACE/'pipe').exists())
        self.assertEqual((list(outside.iterdir()),stat.S_IMODE(outside.stat().st_mode)),([],0o755))
        # The restored copy holds the backup's running job but not the backup's record, so it tells of no failure.
        self.assertTrue((restored/'admin/jobs/fixture/job.json').is_file())
        self.assertEqual(health(restored,NOTHING_SCHEDULED)['failed'],0)

    def test_entries_a_command_made_unreadable_are_listed_and_left_out(self):
        state=new_state(self.root);workspace=state/WORKSPACE
        (workspace/'locked-folder').mkdir(parents=True);(workspace/'locked-folder/upload.pdf').write_bytes(b'%PDF-synthetic')
        (workspace/'locked.txt').write_text('synthetic');(workspace/'kept.txt').write_text('kept')
        (state/'hermes/profiles/other/workspace').mkdir(parents=True)
        real=operations._open
        # Tests run as root, which reads anything: refuse as a chmod 000 would for the owner's own user.
        def refuse(name,flags,folder):
            if name.startswith('locked') or os.readlink(f'/proc/self/fd/{folder}').endswith('/other') and name=='workspace':
                raise PermissionError(errno.EACCES,'Permission denied')
            return real(name,flags,folder)
        with two_stores([]),patch.object(operations,'_open',side_effect=refuse):backup(state,self.root/'backup')
        manifest=validate_snapshot(self.root/'backup')
        self.assertEqual(sorted(manifest['unreadable']),['hermes/profiles/other/workspace',WORKSPACE+'/locked-folder',WORKSPACE+'/locked.txt'])
        self.assertIn(WORKSPACE+'/kept.txt',manifest['files'])
        self.assertFalse(any('locked' in name for name in manifest['files']))
        found=health(state,NOTHING_SCHEDULED,details=True)
        self.assertEqual((found['failed'],found['unreadable']),(0,3))
        self.assertEqual(sorted(found['unreadable_paths']),sorted(manifest['unreadable']))
        self.assertNotIn('unreadable_paths',health(state,NOTHING_SCHEDULED),'the notice gets a count, never a name')
        # Outside a workspace an unreadable file still stops the backup, now with a code and the entry for the page.
        (state/'files/locked-original').write_text('synthetic')
        with two_stores([]),patch.object(operations,'_open',side_effect=refuse):
            with self.assertRaisesRegex(BackupError,'backup_failed') as raised:backup(state,self.root/'second')
        self.assertEqual(raised.exception.path,'files/locked-original')
        self.assertEqual(health(state,NOTHING_SCHEDULED,details=True)['path'],'files/locked-original')

    def test_failed_backups_leave_no_stage_and_count_in_a_row(self):
        state=new_state(self.root);commands=[]
        def failing(output):raise subprocess.CalledProcessError(1,'pg_dump')
        with two_stores(commands,dump=failing):
            with self.assertRaisesRegex(BackupError,'backup_failed'):backup(state,self.root/'first')
        self.assertIn(['fixture','start','--wait','--wait-timeout','300','nocheh-app'],commands)
        self.assertEqual([path.name for path in self.root.iterdir() if path.name.startswith('.backup-')],[])
        # pg_dump fails as a command; the little space left says why.
        usage=operations.shutil.disk_usage(self.root)._replace(free=1024)
        with two_stores([],dump=failing),patch.object(operations.shutil,'disk_usage',return_value=usage):
            with self.assertRaisesRegex(BackupError,'backup_disk_full'):backup(state,self.root/'second')
        with two_stores([]),patch.object(operations,'_add_file',side_effect=OSError(errno.ENOSPC,'No space left on device')):
            with self.assertRaisesRegex(BackupError,'backup_disk_full'):backup(state,self.root/'third')
        self.assertEqual([path.name for path in self.root.iterdir() if path.name.startswith('.backup-')],[])
        found=health(state,NOTHING_SCHEDULED)
        self.assertEqual((found['failed'],found['reason']),(3,'backup_disk_full'))
        self.assertNotIn('path',found)
        with two_stores([]):backup(state,self.root/'fourth')
        self.assertEqual(health(state,NOTHING_SCHEDULED)['failed'],0)

    def test_a_stage_that_cannot_be_removed_never_keeps_the_assistant_stopped(self):
        state=new_state(self.root);order=[];test=self
        class Recovery:
            def __init__(self,*_):pass
            @contextlib.contextmanager
            def maintenance(self):yield
            @contextlib.contextmanager
            def barrier(self):
                order.append('locked');yield;order.append('released')
            def snapshot(self,*_):raise RuntimeError('store_snapshot_changed')
            def assert_barrier(self):pass
            def assert_maintenance(self):pass
        def run(command,**kwargs):
            if 'start' in command:test.assertIn('released',order);order.append('resumed')
        def stuck(*args,**kwargs):
            test.assertEqual(order[-1],'resumed','the stage goes after the restart');raise OSError(errno.EBUSY,'busy')
        with patch('tools.operations.installation.operations.compose',return_value=['fixture']),\
             patch('tools.operations.installation.operations.environment',return_value={'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}),\
             patch('tools.operations.installation.operations.subprocess.check_output',side_effect=['nocheh-app\nnocheh-db\n','fixture-revision']),\
             patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
             patch('tools.operations.workflows.workflow_worker.running',return_value=False),\
             patch('tools.operations.installation.store_recovery.StoreRecovery',Recovery),\
             patch('tools.operations.installation.store_recovery.assert_no_state_writers'),\
             patch.object(operations.shutil,'rmtree',side_effect=stuck):
            with self.assertRaises(OSError):backup(state,self.root/'backup')
        self.assertEqual(order,['locked','released','resumed'])
        self.assertEqual(health(state,NOTHING_SCHEDULED)['failed'],1)

    def test_validation_keeps_workspace_links_and_refuses_everything_else(self):
        link=WORKSPACE+'/current'
        accepted={link:'project'},[(link,tarfile.SYMTYPE,'project'),(WORKSPACE+'/project/notes.txt',tarfile.REGTYPE,b'synthetic')]
        refused={
            'hard link':({},[(WORKSPACE+'/a',tarfile.REGTYPE,b'x'),(WORKSPACE+'/b',tarfile.LNKTYPE,'state/'+WORKSPACE+'/a')]),
            'device':({},[(WORKSPACE+'/device',tarfile.CHRTYPE,None)]),
            'fifo':({},[(WORKSPACE+'/pipe',tarfile.FIFOTYPE,None)]),
            'folder':({},[(WORKSPACE+'/folder',tarfile.DIRTYPE,None)]),
            'listed link outside a workspace':({'hermes/current':'project'},[('hermes/current',tarfile.SYMTYPE,'project')]),
            'unlisted link':({},[(link,tarfile.SYMTYPE,'project')]),
            'another target':({link:'project'},[(link,tarfile.SYMTYPE,'/opt/example')]),
            'file below a link, link first':({link:'project'},[(link,tarfile.SYMTYPE,'project'),(link+'/x',tarfile.REGTYPE,b'x')]),
            'file below a link, file first':({link:'project'},[(link+'/x',tarfile.REGTYPE,b'x'),(link,tarfile.SYMTYPE,'project')]),
            'link below a link':({link:'project',link+'/inner':'x'},[(link,tarfile.SYMTYPE,'project'),(link+'/inner',tarfile.SYMTYPE,'x')]),
            'link and file at once':({link:'project'},[(link,tarfile.SYMTYPE,'project')],{link:{'sha256':'0'*64,'size':0}}),
        }
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);link_snapshot(root,*accepted);validate_snapshot(root)
        for name,case in refused.items():
            with self.subTest(case=name),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);link_snapshot(root,*case)
                with self.assertRaisesRegex(ValueError,'Unsafe'):validate_snapshot(root)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);link_snapshot(root,{link:'project',WORKSPACE+'/other':'x'},[(link,tarfile.SYMTYPE,'project')])
            with self.assertRaisesRegex(ValueError,'Incomplete'):validate_snapshot(root)

    def test_restore_never_reads_writes_or_changes_anything_through_a_link(self):
        outside=self.root/'outside';outside.mkdir();os.chmod(outside,0o755)
        snapshot=self.root/'snapshot';snapshot.mkdir();link=RETIRED+'/data'
        link_snapshot(snapshot,{link:str(outside),WORKSPACE+'/current':'project'},
                      [(link,tarfile.SYMTYPE,str(outside)),(WORKSPACE+'/project/notes.txt',tarfile.REGTYPE,b'synthetic notes'),
                       (WORKSPACE+'/current',tarfile.SYMTYPE,'project')])
        validate_snapshot(snapshot)
        state=self.root/'restored';state.mkdir()
        real=tarfile.TarFile.extractfile
        def files_only(tar,member,*args,**kwargs):
            self.assertTrue(member.isfile(),'a link is never read: tarfile would hand back another member');return real(tar,member,*args,**kwargs)
        with patch.object(tarfile.TarFile,'extractfile',files_only):extract_state(snapshot,state)
        self.assertEqual((os.readlink(state/link),os.readlink(state/WORKSPACE/'current')),(str(outside),'project'))
        notes=state/WORKSPACE/'project/notes.txt'
        self.assertEqual((notes.read_bytes(),stat.S_IMODE(notes.stat().st_mode)),(b'synthetic notes',0o600))
        self.assertEqual((list(outside.iterdir()),stat.S_IMODE(outside.stat().st_mode)),([],0o755))
        # Even an archive validation would refuse cannot write through a link: links come last, and every folder
        # on the way must be a real one.
        unsafe=self.root/'unsafe';unsafe.mkdir()
        link_snapshot(unsafe,{},[(WORKSPACE+'/escape',tarfile.SYMTYPE,str(outside)),(WORKSPACE+'/escape/planted',tarfile.REGTYPE,b'x')])
        target=self.root/'target';target.mkdir()
        with self.assertRaises(FileExistsError):extract_state(unsafe,target)
        (target/'hermes/profiles/second').mkdir(parents=True);(target/'hermes/profiles/second/workspace').symlink_to(outside)
        second=self.root/'second';second.mkdir()
        link_snapshot(second,{},[('hermes/profiles/second/workspace/planted',tarfile.REGTYPE,b'x')])
        with self.assertRaises(OSError):extract_state(second,target)
        self.assertEqual(list(outside.iterdir()),[])

    def test_a_backup_that_cannot_start_is_recorded_and_told(self):
        state=new_state(self.root)
        class Busy:
            def __init__(self,*_):pass
            @contextlib.contextmanager
            def maintenance(self):
                raise RuntimeError('store_maintenance_busy')
                yield
        three={'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}
        with patch('tools.operations.installation.operations.compose',return_value=['fixture']),\
             patch('tools.operations.installation.operations.environment',return_value=three),\
             patch('tools.operations.installation.store_recovery.StoreRecovery',Busy):
            with self.assertRaisesRegex(RuntimeError,'store_maintenance_busy'):backup(state,self.root/'backup')
        found=health(state,NOTHING_SCHEDULED)
        self.assertEqual((found['failed'],found['reason']),(1,'backup_failed'))
        self.assertEqual(read_health(state)['state'],'failed')
        with patch('tools.operations.installation.operations.compose',side_effect=ValueError('missing settings')):
            with self.assertRaises(ValueError):backup(state,self.root/'backup')
        self.assertEqual(health(state,NOTHING_SCHEDULED)['failed'],2)
        missing=self.root/'missing'
        with patch('tools.operations.installation.operations.compose',side_effect=ValueError('missing settings')):
            with self.assertRaises(ValueError):backup(missing,self.root/'backup')
        self.assertFalse(missing.exists(),'no state folder is made for the record')
        with two_stores([]):backup(state,self.root/'backup')
        self.assertEqual(health(state,NOTHING_SCHEDULED)['failed'],0)

    def test_the_command_line_prints_only_the_failure_code_and_tells_the_terminal_why(self):
        output,errors=io.StringIO(),io.StringIO()
        with patch.object(operations,'backup',side_effect=BackupError('backup_unsupported_link','hermes/private-name‮.txt')),\
             contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
            self.assertEqual(operations.main('backup',self.root,['--output',str(self.root/'out')]),1)
        self.assertEqual(json.loads(output.getvalue()),{'error':'backup_unsupported_link'})
        self.assertIn('hermes/private-name\\u202e.txt',errors.getvalue(),'the entry, escaped, for the owner at the terminal')
        self.assertNotIn('‮',errors.getvalue())
        def failing():
            try:raise subprocess.CalledProcessError(1,['fixture','pg_dump'])
            except subprocess.CalledProcessError as error:raise BackupError('backup_failed') from error
        output,errors=io.StringIO(),io.StringIO()
        with patch.object(operations,'backup',side_effect=lambda *_:failing()),contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
            self.assertEqual(operations.main('backup',self.root,['--output',str(self.root/'out')]),1)
        self.assertEqual(output.getvalue().strip().splitlines(),['{"error": "backup_failed"}'])
        self.assertIn('CalledProcessError',errors.getvalue());self.assertIn('pg_dump',errors.getvalue())
