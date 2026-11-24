"""Consistent local backups and inactive restores into a new Compose project."""
import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import urllib.request
from datetime import datetime,timezone
from contextlib import ExitStack
from pathlib import Path,PurePosixPath

from tools.operations.installation.configuration import compose_environment, env_path, initialize, load, write_env, INSTALLATION_ROOT, compose_command, archive_url, runtime_folders, cut_over, generate, ROTATED
ROOT=INSTALLATION_ROOT
SERVICES=['nocheh-telegram','hermes','nocheh-app','honcho-api','honcho-deriver','honcho-provider-gateway','honcho-redis','inngest-server','hermes-agent-sb','nocheh-security']
TABLES={'events':'id','artifacts':'id','derived_artifacts':'id','dispatches':'event_id',
        'guard_sources':'id','guard_revisions':'id','guard_fragments':'id','guard_state':'singleton','guard_invalidations':'id',
        'guard_context_values':'id','guard_context_inputs':'id',
        'honcho_connection':'singleton','honcho_generations':'id','honcho_receipts':'id',
        'honcho_prepared_sources':'source_id,guard_epoch,policy_revision','honcho_context_cache':'generation',
        'spool_failures':'file_name','guarded_cache':'cache_key','transcription_jobs':'artifact_id','action_requests':'id',
        'event_spaces':'event_id','memory_policy_state':'singleton','memory_spaces':'id','memory_shares':'id',
        'memory_learning_sources':'event_id','memory_review_jobs':'id','memory_filtered':'id','managed_runs':'event_id','controlled_actions':'id','action_permissions':'id',
        'security_policy_versions':'revision','security_policy':'singleton','security_events':'id'}
TABLES.update(workflow_owners='family',workflow_registry='id',workflow_outbox='id',workflow_runs='workflow_id,run_id',workflow_receipts='workflow_id,step,attempt')
TABLES.update(workflow_request_revisions='family,job_id')
TABLES.update(workflow_imports='id',workflow_host_receipts='token')
TABLES.update(workflow_worker_registrations='family')
TABLES.update(workflow_schedules='id')
TABLES.update(workflow_controls='workflow_id,revision,action')
TABLES.update(workflow_migrations='id')
TABLES.update(source_model_migrations='version',source_objects='id',source_revisions='id',
              source_observations='event_id',source_relations='event_id,kind,target_id')


def compose(state,project=None):
    return compose_command(state,project)


def environment(state): return compose_environment(state)


def sha(path):
    result=hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda:file.read(1024*1024),b''): result.update(chunk)
    return result.hexdigest()


def sync(path):
    with path.open('rb') as file: os.fsync(file.fileno())


def fingerprints(command,env,tables=None):
    result={}
    if tables is None:
        raw=subprocess.check_output(command+['exec','-T','nocheh-db','psql','-X','-A','-t','-U','nocheh','-d','nocheh','-c',
            "SELECT tablename FROM pg_tables WHERE schemaname='public'"],env=env,text=True)
        tables=[name for name in raw.split() if name in TABLES]
    if not set(tables).issubset(TABLES): raise ValueError('Unknown snapshot table')
    for table in tables:
        key=TABLES[table]
        query=f'COPY (SELECT row_to_json(t) FROM (SELECT * FROM public.{table} ORDER BY {key}) t) TO STDOUT'
        process=subprocess.Popen(command+['exec','-T','nocheh-db','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh','-c',query],env=env,stdout=subprocess.PIPE)
        digest=hashlib.sha256()
        while chunk:=process.stdout.read(1024*1024): digest.update(chunk)
        if process.wait(): raise RuntimeError('database_fingerprint_failed')
        result[table]=digest.hexdigest()
    return result


# Honcho's build file is generated into its source checkout, not here, so a backup never holds it.
HONCHO_STATE=('honcho.env','meter.env','internal_token','database_password','temporary_embedding_key')
# Approved shell commands run in a profile's workspace, also after the profile is retired. A link they leave
# there is kept as a link: stored as one, restored last, never followed (ADR-0251). A link anywhere else
# still stops the backup.
WORKSPACE_ENTRY=re.compile(r'hermes/(?:profiles|retired-profiles)/[^/]+/workspace/.+',re.S)
# The workspace folder and everything in it: what a command made unreadable there is listed and left out.
WORKSPACE=re.compile(r'hermes/(?:profiles|retired-profiles)/[^/]+/workspace(?:/.+)?',re.S)
REBUILDABLE_CACHE=re.compile(r'(hermes/(?:profiles/[^/]+/)?\.cache/uv)(?:/|$)')
# Why a workspace entry could not be opened: its permissions, or too many folders deep to hold open.
UNREADABLE=(errno.EACCES,errno.EPERM,errno.EMFILE,errno.ENFILE)
# With less free space than this after a dump or copy failed, the disk filled up.
FULL_DISK=64*1024**2
CLOEXEC=getattr(os,'O_CLOEXEC',0)
OPEN_FILE=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|CLOEXEC
OPEN_FOLDER=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|CLOEXEC


class BackupError(ValueError):
    """A backup that did not finish, by a fixed code such as backup_unsupported_link. `path` names the entry
    for System › Backups only; it never reaches a Telegram notice, because a command chooses file names."""
    def __init__(self,code,path=None):
        super().__init__(code);self.code=code;self.path=path


def _open(name,flags,folder):
    """Opens one entry of an open folder. Tests replace it to stand for an entry a command made unreadable."""
    return os.open(name,flags,dir_fd=folder)


class _Hashed:
    """Hands tarfile a file's bytes and hashes exactly the bytes it stores, so the manifest matches the archive."""
    def __init__(self,file):
        self.file=file;self.digest=hashlib.sha256()

    def read(self,size=-1):
        data=self.file.read(size);self.digest.update(data);return data


def _add_file(tar,manifest,relative,descriptor,seen):
    """Stores an opened regular file as a plain copy; a second name for the same file is a copy too."""
    with os.fdopen(descriptor,'rb') as file:
        status=os.fstat(file.fileno())
        # The entry changed between looking at it and opening it.
        if not stat.S_ISREG(status.st_mode) or (status.st_dev,status.st_ino)!=(seen.st_dev,seen.st_ino):
            raise BackupError('backup_failed',relative)
        info=tarfile.TarInfo('state/'+relative);info.type=tarfile.REGTYPE;info.size=status.st_size
        info.mode=status.st_mode&0o777;info.mtime=int(status.st_mtime)
        reader=_Hashed(file);tar.addfile(info,reader)
    manifest['files'][relative]={'sha256':reader.digest.hexdigest(),'size':status.st_size}


def _add_root(tar,manifest,name,base):
    """Adds one copied root without following any link: every folder and file is opened from its open parent
    folder. Links are stored as links in workspaces, FIFOs, sockets and devices are skipped and listed, and in a
    workspace an entry that cannot be opened is listed as unreadable instead of failing the backup."""
    folders=[]

    def unreadable(relative,error):
        if WORKSPACE.fullmatch(relative) and isinstance(error,OSError) and error.errno in UNREADABLE:
            manifest['unreadable'].append(relative);return True
        return False

    def visit(folder,entry,relative):
        cache=REBUILDABLE_CACHE.match(relative)
        if cache:
            # Native uv may create wheel-cache links. This exact
            # dependency cache is rebuildable, never owned memory.
            if cache[1] not in manifest['excluded_rebuildable_caches']:manifest['excluded_rebuildable_caches'].append(cache[1])
            return
        try:status=os.stat(entry,dir_fd=folder,follow_symlinks=False)
        except OSError as error:
            if unreadable(relative,error):return
            raise BackupError('backup_failed',relative) from error
        if stat.S_ISLNK(status.st_mode):
            # A workspace link is tested first, so a workspace folder named plugins/nocheh stays a link too.
            if WORKSPACE_ENTRY.fullmatch(relative):
                target=os.readlink(entry,dir_fd=folder)
                info=tarfile.TarInfo('state/'+relative);info.type=tarfile.SYMTYPE;info.linkname=target
                info.mode=0o777;info.mtime=int(status.st_mtime);tar.addfile(info)
                manifest['links'][relative]=target;return
            if relative.endswith('plugins/nocheh'):
                manifest['recreated_plugin_links'].append(relative);return
            raise BackupError('backup_unsupported_link',relative)
        if stat.S_ISDIR(status.st_mode):
            try:descriptor=_open(entry,OPEN_FOLDER,folder)
            except OSError as error:
                if unreadable(relative,error):return
                raise BackupError('backup_failed',relative) from error
            try:
                opened=os.fstat(descriptor)
                if (opened.st_dev,opened.st_ino)!=(status.st_dev,status.st_ino):raise BackupError('backup_failed',relative)
                names=sorted(os.listdir(descriptor))
            except OSError as error:
                os.close(descriptor)
                if unreadable(relative,error):return
                raise BackupError('backup_failed',relative) from error
            except BaseException:
                os.close(descriptor);raise
            folders.append([relative,descriptor,names,0]);return
        if stat.S_ISREG(status.st_mode):
            try:descriptor=_open(entry,OPEN_FILE,folder)
            except OSError as error:
                if unreadable(relative,error):return
                raise BackupError('backup_failed',relative) from error
            _add_file(tar,manifest,relative,descriptor,status);return
        # FIFOs, sockets and devices hold no data; opening a FIFO could wait forever.
        manifest['skipped_special_files'].append(relative)

    parent=os.open(base.parent,os.O_RDONLY|os.O_DIRECTORY|CLOEXEC)
    try:
        visit(parent,base.name,name)
        # Depth first, one open folder per level, so a deep tree never meets Python's recursion limit.
        while folders:
            current=folders[-1]
            if current[3]>=len(current[2]):
                os.close(current[1]);folders.pop();continue
            entry=current[2][current[3]];current[3]+=1
            visit(current[1],entry,current[0]+'/'+entry)
    finally:
        for current in folders:os.close(current[1])
        os.close(parent)


def _failure(error,folder):
    """Why a backup did not finish, as a fixed code."""
    if isinstance(error,BackupError):return error.code
    if isinstance(error,OSError) and error.errno==errno.ENOSPC:return 'backup_disk_full'
    # pg_dump and the store snapshots fail as a command; what is left free tells a full disk.
    try:
        if shutil.disk_usage(folder).free<FULL_DISK:return 'backup_disk_full'
    except OSError:pass
    return 'backup_failed'


def honcho_state(memory):
    """Honcho state files to back up."""
    def regular(path):return path.is_file() and not path.is_symlink()
    if not all(regular(memory/name) for name in HONCHO_STATE):raise ValueError('honcho_backup_state_missing')
    return list(HONCHO_STATE)


def source_revision():
    """The checkout's commit, or None where the code has no Git checkout (the dashboard image)."""
    try:return subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True,stderr=subprocess.DEVNULL).strip()
    except (OSError,subprocess.CalledProcessError):return None


def backup(state,output,leave_stopped=False):
    from tools.operations.installation.backup_schedule import record_backup
    outcome={'unreadable':[]}
    try:
        command=compose(state);env=environment(state)
        if output.exists(): raise ValueError('Backup destination already exists')
        if env.get('NOCHEH_STORAGE_LAYOUT')=='original-only-v1':
            copied_roots=[Path(state)/name for name in ('files','spool','hermes','telegram','admin/jobs','admin/tools/receipts','admin/dashboard/home')]
            if any(output.resolve().is_relative_to(root.resolve()) for root in copied_roots):
                raise ValueError('Backup destination would be included in its own snapshot')
            from tools.operations.installation.store_recovery import StoreRecovery
            recovery=StoreRecovery(command,env)
            with recovery.maintenance():return _backup(state,output,leave_stopped,command,env,outcome,recovery)
        return _backup(state,output,leave_stopped,command,env,outcome)
    except BaseException as error:
        # A backup that could not start, such as one that found the stores' maintenance lock taken, did not
        # finish either, so the owner is told (ADR-0251). One that started has recorded its own end, and a state
        # folder that does not exist is never made for the record.
        if not outcome.get('recorded') and Path(state).is_dir():
            record_backup(state,'failed',error='backup_failed' if isinstance(error,Exception) else 'backup_interrupted')
        raise


def _backup(state,output,leave_stopped,command,env,outcome,recovery=None):
    """Makes the backup and records how it ended in admin/backup-health.json, which feeds the owner's notice
    (ADR-0251). That record sits outside the copied roots, so a restored copy never inherits a running backup."""
    from tools.operations.installation.backup_schedule import record_backup
    record_backup(state,'running');outcome['recorded']=True
    try:result=_make(state,output,leave_stopped,command,env,recovery,outcome)
    except BaseException as error:
        if outcome.get('finished'):record_backup(state,'complete',unreadable=outcome['unreadable'])
        else:
            code=outcome.get('code') or (_failure(error,output.parent) if isinstance(error,Exception) else 'backup_interrupted')
            record_backup(state,'failed',error=code,path=outcome.get('path'))
        raise
    record_backup(state,'complete',unreadable=outcome['unreadable'])
    return result


def _make(state,output,leave_stopped,command,env,recovery,outcome):
    from tools.operations.workflows.workflow_worker import running as workflows_running,stop as stop_workflows
    output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    running=subprocess.check_output(command+['ps','--services','--status','running'],env=env,text=True).split()
    three_stores=env.get('NOCHEH_STORAGE_LAYOUT')=='original-only-v1'
    from tools.operations.installation.management_maintenance import coordinating_dashboard
    coordinator=coordinating_dashboard(state,command,env) if three_stores else None
    exempt={'nocheh-db','honcho-postgres','inngest-redis','nocheh-executor'}
    if coordinator:exempt.add('nocheh-dashboard')
    stopped=([name for name in running if name not in exempt]
        if three_stores else [name for name in SERVICES if name in running])
    barrier=ExitStack()
    workflow_was_running=workflows_running(state)
    # Ingress, one at a time: the Telegram bot stops reading and sending before the agent stops answering.
    ingress=('nocheh-telegram','hermes')
    stage=None
    try:
        stage=Path(tempfile.mkdtemp(prefix='.backup-',dir=output.parent));stage.chmod(0o700)
        for service in ingress:
            if service in stopped:subprocess.run(command+['stop',service],env=env,check=True)
        if workflow_was_running:stop_workflows(state,wait=True)
        # Stop ingress first; then writers. PostgreSQL remains available to pg_dump.
        for service in stopped:
            if service not in ingress:subprocess.run(command+['stop',service],env=env,check=True)
        # Backups made before links were kept have no 'links', 'skipped_special_files' or 'unreadable'; they stay valid.
        manifest={'version':3,'created_at':datetime.now(timezone.utc).isoformat(),
                  'git_revision':source_revision(),
                  'files':{},'links':{},'recreated_plugin_links':[],'excluded_rebuildable_caches':[],
                  'skipped_special_files':[],'unreadable':outcome['unreadable']}
        if three_stores:
            from tools.operations.installation.store_recovery import assert_no_state_writers
            assert_no_state_writers(state,env,command,coordinator)
            barrier.enter_context(recovery.barrier())
            manifest['stores']=recovery.snapshot(stage,sha)
            manifest['tables']={store:record['tables'] for store,record in manifest['stores']['databases'].items()}
        else:
            manifest['tables']=fingerprints(command,env)
            dump=stage/'archive.dump'
            with dump.open('xb') as file:
                subprocess.run(command+['exec','-T','nocheh-db','pg_dump','-U','nocheh','-d','nocheh','-Fc','--no-owner'],env=env,stdout=file,check=True)
            dump.chmod(0o600);sync(dump);manifest['dump_sha256']=sha(dump)
        from tools.operations.workflows.workflow_recovery import enabled_or_present,snapshot as workflow_snapshot
        if enabled_or_present(state,env):
            manifest.update(version=4,workflows=workflow_snapshot(command,env,stage,sha))
        memory_state=Path(env.get('NOCHEH_HONCHO_STATE_DIR') or state/'honcho')
        if env.get('NOCHEH_HONCHO_ENABLED')=='true':
            from tools.operations.memory.honcho_recovery import snapshot as memory_snapshot
            manifest.update(version=5,honcho=memory_snapshot(command,env,stage,sha))
        archive=stage/'state.tar.gz'
        with tarfile.open(archive,'w:gz',dereference=False) as tar:
            for name in ('.env','files','spool','hermes','telegram','admin/jobs','admin/tools/receipts','admin/dashboard/home'):
                base=env_path(state) if name=='.env' else state/name
                # The bot's folder holds only its last incident; a state from before nocheh-telegram has none.
                if (name.startswith('admin/') or name=='telegram') and not base.exists(): continue
                _add_root(tar,manifest,name,base)
            if manifest.get('honcho'):
                for name in honcho_state(memory_state):
                    path=memory_state/name
                    relative='honcho/'+name
                    manifest['files'][relative]={'sha256':sha(path),'size':path.stat().st_size}
                    tar.add(path,arcname='state/'+relative,recursive=False)
            # Provider reservations live outside the archive. Snapshot them with
            # SQLite's backup API; restoring Nocheh never resets the live ledger.
            memory_state=env.get('NOCHEH_HONCHO_STATE_DIR') or (ROOT/'data/honcho-experiment' if state.resolve()==(ROOT/'data/local').resolve() else state/'honcho')
            ledger=Path(memory_state)/'ledger/budget.sqlite'
            if ledger.is_file():
                copy=stage/'memory-budget.sqlite';source=sqlite3.connect(ledger.as_uri()+'?mode=ro',uri=True);target=sqlite3.connect(copy)
                try:source.backup(target);target.commit()
                finally:source.close();target.close()
                copy.chmod(0o600);relative='memory-ledger/budget.sqlite'
                manifest['files'][relative]={'sha256':sha(copy),'size':copy.stat().st_size}
                tar.add(copy,arcname='state/'+relative,recursive=False)
                copy.unlink()
        archive.chmod(0o600);sync(archive);manifest['state_sha256']=sha(archive)
        if three_stores:
            recovery.assert_barrier();manifest.update(version=6,storage_layout='original-only-v1')
            if coordinator:coordinator.assert_current()
        metadata=stage/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n');metadata.chmod(0o600);sync(metadata)
        if three_stores:validate_snapshot(stage)
        stage.rename(output);outcome['finished']=True
        descriptor=os.open(output.parent,os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
        return {'status':'backed_up','path':str(output),'files':len(manifest['files']),'tables':sum(len(v) for v in manifest['tables'].values()) if three_stores else len(manifest['tables'])}
    except Exception as error:
        # Measured before the stage is removed: a full disk is still full now.
        outcome.update(code=_failure(error,output.parent),path=getattr(error,'path',None))
        if isinstance(error,BackupError) or outcome.get('finished'):raise
        raise BackupError(outcome['code']) from error
    finally:
        try:
            barrier.close()
            if three_stores:recovery.assert_maintenance()
            if coordinator:coordinator.assert_current()
            if not leave_stopped:_restart(command,env,stopped,state,workflow_was_running)
        finally:
            # An unfinished stage goes last, so removing gigabytes never keeps the stores locked or the assistant
            # stopped; anything left behind is swept by the schedule after 12 hours.
            if stage is not None and not outcome.get('finished'):shutil.rmtree(stage,ignore_errors=True)


# Seconds Compose waits for the restarted services to be healthy. In development the app and the security service first
# wait up to 120 s for their build's store setup (src/stores/dev-schema.ts); the agent starts only after them.
RESTART_WAIT=300
# A service can turn unhealthy before it settles, and Compose then gives up at once. One passing check makes it healthy
# again, so the start is tried again every RESTART_PAUSE seconds for up to RESTART_PATIENCE seconds.
RESTART_PATIENCE=600
RESTART_PAUSE=15


def _restart(command,env,services,state,workflows):
    """Starts the existing containers the backup stopped, then the workflow host. Each step runs even when the one
    before it failed, and a failed start is tried again, so one slow service never leaves the others stopped. Raises
    the last failure once every step has run."""
    from tools.operations.workflows.workflow_worker import resume_existing
    failure=None
    if services:
        # Resume the existing containers. A development stack may use a different Compose overlay or pinned image IDs
        # than this checkout's configuration; `up` can recreate it or try to pull unavailable local image tags.
        deadline=time.monotonic()+RESTART_PATIENCE
        while True:
            try:
                subprocess.run(command+['start','--wait','--wait-timeout',str(RESTART_WAIT)]+services,env=env,check=True)
                failure=None;break
            except Exception as error:
                failure=error
                if time.monotonic()+RESTART_PAUSE>=deadline:break
                print('Backup restart: services are not healthy yet; trying again.',file=sys.stderr,flush=True)
                time.sleep(RESTART_PAUSE)
    if workflows:
        try:resume_existing(state)
        except Exception as error:failure=error
    if failure is not None:raise failure


def validate_snapshot(snapshot):
    manifest=json.loads((snapshot/'manifest.json').read_text())
    if manifest.get('version') not in (1,2,3,4,5,6) or sha(snapshot/'state.tar.gz')!=manifest['state_sha256']:
        raise ValueError('Backup checksum mismatch')
    if manifest['version']==6:
        from tools.operations.installation.store_recovery import validate
        if manifest.get('storage_layout')!='original-only-v1':raise ValueError('Backup storage layout mismatch')
        validate(snapshot,manifest.get('stores'),sha)
        if manifest.get('tables')!={store:record['tables'] for store,record in manifest['stores']['databases'].items()}:
            raise ValueError('Backup table manifest mismatch')
    elif sha(snapshot/'archive.dump')!=manifest['dump_sha256']:raise ValueError('Backup checksum mismatch')
    if manifest['version']==4 or manifest.get('workflows'):
        from tools.operations.workflows.workflow_recovery import validate
        validate(snapshot,manifest.get('workflows'),sha)
    if manifest['version']==5 or manifest.get('honcho'):
        from tools.operations.memory.honcho_recovery import validate as validate_honcho
        validate_honcho(snapshot,manifest.get('honcho'),sha)
    files=manifest['files']
    # Backups made before workspace links were kept list none, and stay restorable (ADR-0251).
    links=manifest.get('links') or {}
    if not isinstance(links,dict) or set(links)&set(files) or any(
            not isinstance(path,str) or not WORKSPACE_ENTRY.fullmatch(path) or not isinstance(target,str) or not target or '\0' in target
            for path,target in links.items()):
        raise ValueError('Unsafe backup member')
    # Nothing may sit below a link, whatever order the archive lists its members in, so a restore never writes through one.
    def below_link(relative):
        parts=relative.split('/')
        return any('/'.join(parts[:end]) in links for end in range(1,len(parts)))
    if any(below_link(relative) for relative in (*files,*links)):raise ValueError('Unsafe backup member')
    seen=set()
    with tarfile.open(snapshot/'state.tar.gz','r:gz') as tar:
        for member in tar:
            parts=PurePosixPath(member.name).parts
            if len(parts)<2 or parts[0]!='state' or '..' in parts or PurePosixPath(member.name).is_absolute(): raise ValueError('Unsafe backup member')
            relative='/'.join(parts[1:])
            if relative in seen: raise ValueError('Unexpected backup member')
            if member.issym():
                # Its target is only compared, never read: tarfile would hand back another member's bytes.
                if links.get(relative)!=member.linkname: raise ValueError('Unsafe backup member')
                seen.add(relative);continue
            # Hard links, devices, FIFOs and folders are never stored.
            if not member.isfile(): raise ValueError('Unsafe backup member')
            if relative not in files: raise ValueError('Unexpected backup member')
            seen.add(relative);spec=files[relative]
            digest=hashlib.sha256()
            with tar.extractfile(member) as file:
                for chunk in iter(lambda:file.read(1024*1024),b''): digest.update(chunk)
            if member.size!=spec['size'] or digest.hexdigest()!=spec['sha256']: raise ValueError('State file checksum mismatch')
    if seen!=set(files)|set(links): raise ValueError('Incomplete backup')
    return manifest


def _folder(state,relative):
    """Opens a folder below the new state, making each missing one on the way, one at a time and never through a
    link: every step must be a real folder. A folder may hold only links, so it may not exist yet."""
    descriptor=os.open(state,os.O_RDONLY|os.O_DIRECTORY|CLOEXEC)
    try:
        for part in PurePosixPath(relative).parts:
            try:os.mkdir(part,0o700,dir_fd=descriptor)
            except FileExistsError:pass
            child=os.open(part,OPEN_FOLDER,dir_fd=descriptor)
            os.close(descriptor);descriptor=child
    except BaseException:
        os.close(descriptor);raise
    return descriptor


def extract_state(snapshot,state):
    """Writes a validated snapshot's files into the new state folder, then its workspace links last (ADR-0251).
    Nothing is written or changed through a link: each file is new, and a link is never opened or chmodded."""
    links=[]
    with tarfile.open(snapshot/'state.tar.gz','r:gz') as tar:
        for member in tar:
            relative=PurePosixPath(member.name).relative_to('state')
            if member.issym():
                links.append((relative,member.linkname));continue
            folder=_folder(state,relative.parent)
            try:
                descriptor=os.open(relative.name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|CLOEXEC,0o600,dir_fd=folder)
                with tar.extractfile(member) as source,os.fdopen(descriptor,'wb') as target:
                    shutil.copyfileobj(source,target);os.fchmod(target.fileno(),0o600)
            finally:os.close(folder)
    for relative,target in links:
        folder=_folder(state,relative.parent)
        try:os.symlink(target,relative.name,dir_fd=folder)
        finally:os.close(folder)


def restore(snapshot,state,project,port):
    if state.exists(): raise ValueError('Restore requires a new, nonexistent state directory')
    from tools.operations.installation import workspaces
    if not re.fullmatch(r'nocheh-[a-z0-9-]{3,50}',project) or not workspaces.NAME.fullmatch(project[7:]): raise ValueError('Use a new nocheh-* Compose project name')
    if subprocess.run(['docker','volume','inspect',project+'_postgres_data'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        raise ValueError('Restore project database volume already exists')
    # A restore never takes a workspace's ports (ADR-0245): without --port it gets the first free ones.
    listed=workspaces.listed()
    # Its name, not only its project, stays clear of every workspace: the name decides the off-site folder.
    if workspaces.name_of_project(project) in {workspaces.DEFAULT,*(name for name,_,_ in listed)}:raise ValueError('Restore project is a workspace; use a new nocheh-* Compose project name')
    taken=set().union(set(),*(workspaces.claims(values,folder)['ports'] for _,folder,values in listed))
    taken|=workspaces._published(workspaces.containers())
    if port is None:port=workspaces.free_port(taken)
    elif set(workspaces.ports({'NOCHEH_PORT':str(port)}).values())&taken:raise ValueError('Restore ports are used by a workspace; pass another --port')
    manifest=validate_snapshot(snapshot)
    state.mkdir(parents=True,mode=0o700)
    # Before extraction, so every folder the services mount has 0700 even if the snapshot lacks it.
    runtime_folders(state)
    extract_state(snapshot,state)
    # Machine keys are never in a snapshot: the restored machines need a new key and test before a job may use them.
    for directory in ('secrets','machines'): (state/directory).mkdir(exist_ok=True,mode=0o700)
    # Retain the saved settings, but don't activate a duplicate Hermes credential owner.
    auth=state/'hermes/auth.json'
    if auth.exists(): auth.rename(state/'hermes/auth.restore-pending.json')
    config=initialize(state) if manifest['version']==1 else load(state)
    # A backup from before the agent login (ADR-0291) gets it, the session token and a new SERVICE_TOKEN, as an upgrade does.
    if manifest['version']>1 and not config.get('AGENT_KEY'):cut_over(config);generate(config,ROTATED)
    write_env(state/'restored.env',config)
    config.update(TELEGRAM_ENABLED='false',NOCHEH_HONCHO_ENABLED='false',NOCHEH_HONCHO_STATE_DIR=str(state/'honcho'),
                  NOCHEH_HONCHO_DATABASE_VOLUME=project+'_honcho_database',NOCHEH_HONCHO_REDIS_VOLUME=project+'_honcho_redis',
                  NOCHEH_UID=str(os.getuid()),NOCHEH_GID=str(os.getgid()),NOCHEH_PORT=str(port),
                  NOCHEH_DASHBOARD_PORT=str(port+3 if port<=65532 else port-3),
                  COMPOSE_PROJECT_NAME=project,NOCHEH_MEMORY_TOKEN='',NOCHEH_MEMORY_NETWORK=project+'-memory',NOCHEH_AGENT_NETWORK=project+'-agent',
                  # Its own name, so it never lists or prunes the workspace's off-site copies, and this checkout's images.
                  NOCHEH_WORKSPACE=workspaces.name_of_project(project),
                  NOCHEH_IMAGES=workspaces.images(workspaces.checkout_settings(ROOT) or {}))
    (state/'admin/tools').mkdir(parents=True,exist_ok=True,mode=0o700)
    (state/'admin/tools/inactive').touch()
    (state/'hermes/scheduler-inactive').touch()
    (state/'spool/.restore-inactive').touch()
    (state/'workflows').mkdir(parents=True,exist_ok=True,mode=0o700)
    (state/'workflows/inactive').touch()
    if manifest['version']==6:config['NOCHEH_STORAGE_LAYOUT']='original-only-v1'
    write_env(env_path(state),config)
    command=compose(state,project);env=environment(state)
    subprocess.run(command+['up','-d','--wait','nocheh-db'],env=env,check=True)
    if manifest['version']==6:
        from tools.operations.installation.store_recovery import StoreRecovery
        StoreRecovery(command,env).restore_inactive(snapshot,manifest['stores'],sha)
        actual=manifest['tables']
    else:
        with (snapshot/'archive.dump').open('rb') as file:
            subprocess.run(command+['exec','-T','nocheh-db','pg_restore','-U','nocheh','-d','nocheh','--no-owner','--exit-on-error'],env=env,stdin=file,check=True)
        # Old snapshots predate the policy tables; verify exactly their recorded set.
        actual=fingerprints(command,env,manifest['tables'])
        if actual!=manifest['tables']: raise RuntimeError('Restored database differs from the snapshot')
    if manifest.get('workflows'):
        from tools.operations.workflows.workflow_recovery import restore as restore_workflows
        restore_workflows(command,env,snapshot,state,manifest['workflows'],sha)
    if manifest.get('honcho'):
        from tools.operations.memory.honcho_recovery import restore as restore_honcho
        restore_honcho(command,env,snapshot,state,manifest['honcho'],sha)
    if 'honcho_connection' in manifest['tables']:
        subprocess.run(command+['exec','-T','nocheh-db','psql','-X','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh','-c',
            "UPDATE honcho_connection SET attached=false,verified=false; UPDATE guard_state SET epoch=epoch+1;"],env=env,check=True,stdout=subprocess.DEVNULL)
    if manifest['version']!=6:
        # Telegram is off in the restored settings, so nocheh-telegram starts without polling or sending.
        subprocess.run(command+['up','-d','--no-build','--wait','--wait-timeout','180','nocheh-app','nocheh-security','hermes','hermes-agent-sb','nocheh-telegram','inngest-server'],env=env,check=True)
    result={'status':'restored_inactive','state':str(state),'project':project,'port':port,
            'verified_tables':list(actual),'verified_state_files':len(manifest['files']),
            'telegram_enabled':False,'hermes_login_activated':False}
    result['honcho_attached']=False
    result['executors_active']=False
    (state/'reports/restore.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main(command,state,rest):
    parser=argparse.ArgumentParser(description=__doc__)
    if command=='diagnose':
        parser.parse_args(rest)
        from tools.operations.installation.services import containers,describe,host_status
        result={'containers':describe(containers(compose(state),environment(state)),load(state),host_status(state))}
        result['execution_holds']={
            'workflows':(state/'workflows/inactive').exists(),
            'workers':(state/'spool/.restore-inactive').exists(),
            'tools':(state/'admin/tools/inactive').exists(),
            'scheduler':(state/'hermes/scheduler-inactive').exists(),
            'hermes_login':(state/'hermes/auth.restore-pending.json').exists(),
        }
        config=load(state)
        port=int(config.get('NOCHEH_PORT','8780'))
        request=urllib.request.Request(archive_url(state)+'/v1/status',headers={'Authorization':'Bearer '+config['SERVICE_TOKEN']})
        try:
            with urllib.request.urlopen(request,timeout=10) as response: result['archive']=json.load(response)
        except Exception as error: result['archive']={'error':type(error).__name__}
        def health(service,port):
            try:
                raw=subprocess.check_output(compose(state)+['exec','-T',service,'python','-c',
                    f"import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:{port}/health',timeout=5))))"],env=environment(state),text=True)
                return json.loads(raw)
            except Exception as error: return {'error':type(error).__name__}
        result['hermes']=health('hermes',8781)
        # Reports on the Hermes page's script rules, before they are enforced (ADR-0251).
        from tools.operations.installation.dashboard import script_reports
        result['hermes_page_script_reports']=script_reports(state)
        # The Telegram state comes from the bot itself; Hermes no longer talks to Telegram.
        result['telegram']=health('nocheh-telegram',8784)
    elif command=='backup':
        parser.add_argument('--output',type=Path,default=ROOT/'data/backups'/time.strftime('%Y%m%d-%H%M%S'))
        parser.add_argument('--leave-stopped',action='store_true',help='Keep writers stopped for a planned cutover')
        args=parser.parse_args(rest)
        try:result=backup(state,args.output.resolve(),args.leave_stopped)
        except BackupError as error:
            # Only the fixed code on stdout: the dashboard names it, and System › Backups shows the entry from the
            # backup's record. The entry and the cause go to the terminal, escaped like that page shows them, since a
            # command chooses file names; the dashboard discards stderr.
            from tools.operations.installation.backup_schedule import shown
            if error.path:print('Entry: '+shown(error.path),file=sys.stderr)
            if error.__cause__ is not None:
                for line in ''.join(traceback.format_exception(error.__cause__)).splitlines():print(shown(line,2000),file=sys.stderr)
            print(json.dumps({'error':error.code}),flush=True);return 1
    else:
        parser.add_argument('snapshot',type=Path);parser.add_argument('--state',type=Path,required=True)
        parser.add_argument('--project',required=True);parser.add_argument('--port',type=int,help='Default: the first free ports')
        args=parser.parse_args(rest)
        if args.port is not None and not 1024<=args.port<=65535: parser.error('Port must be between 1024 and 65535')
        result=restore(args.snapshot.resolve(),args.state.resolve(),args.project,args.port)
    print(json.dumps(result,indent=2));return 0
