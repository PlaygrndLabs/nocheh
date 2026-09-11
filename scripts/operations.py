"""Consistent local backups and inactive restores into a new Compose project."""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath

try: from .configuration import compose_environment, env_path, initialize, load, write_env
except ImportError: from configuration import compose_environment, env_path, initialize, load, write_env

ROOT=Path(__file__).resolve().parents[1]
SERVICES=['hermes','workflow-worker','worker','inngest','security-launcher','security','guard','archive','speech','provider-monitor','cliproxy']
TABLES={'events':'id','artifacts':'id','derived_artifacts':'id','dispatches':'event_id',
        'guard_sources':'id','guard_revisions':'id','guard_fragments':'id','guard_state':'singleton','guard_invalidations':'id',
        'guard_context_values':'id','guard_context_inputs':'id',
        'honcho_connection':'singleton','honcho_generations':'id','honcho_receipts':'id',
        'honcho_prepared_sources':'source_id,guard_epoch,policy_revision',
        'spool_failures':'file_name','guarded_cache':'cache_key','transcription_jobs':'artifact_id','action_requests':'id',
        'event_spaces':'event_id','memory_policy_state':'singleton','memory_spaces':'id','memory_shares':'id',
        'memory_learning_sources':'event_id','memory_review_jobs':'id','memory_filtered':'id','managed_runs':'event_id','controlled_actions':'id','action_permissions':'id',
        'security_policy_versions':'revision','security_policy':'singleton','security_events':'id'}
TABLES.update(workflow_owners='family',workflow_registry='id',workflow_outbox='id',workflow_runs='workflow_id,run_id',workflow_receipts='workflow_id,step,attempt')
TABLES.update(workflow_request_revisions='family,job_id')
TABLES.update(workflow_imports='id',workflow_host_receipts='token')
TABLES.update(workflow_worker_registrations='family')


def compose(state,project=None):
    result=['docker','compose','--env-file',str(env_path(state)),'-f',str(ROOT/'docker-compose.yml')]
    if project: result+=['-p',project]
    return result


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
        raw=subprocess.check_output(command+['exec','-T','postgres','psql','-X','-A','-t','-U','nocheh','-d','nocheh','-c',
            "SELECT tablename FROM pg_tables WHERE schemaname='public'"],env=env,text=True)
        tables=[name for name in raw.split() if name in TABLES]
    if not set(tables).issubset(TABLES): raise ValueError('Unknown snapshot table')
    for table in tables:
        key=TABLES[table]
        query=f'COPY (SELECT row_to_json(t) FROM (SELECT * FROM public.{table} ORDER BY {key}) t) TO STDOUT'
        process=subprocess.Popen(command+['exec','-T','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh','-c',query],env=env,stdout=subprocess.PIPE)
        digest=hashlib.sha256()
        while chunk:=process.stdout.read(1024*1024): digest.update(chunk)
        if process.wait(): raise RuntimeError('database_fingerprint_failed')
        result[table]=digest.hexdigest()
    return result


def backup(state,output,leave_stopped=False):
    try:from .tool_worker import running as tools_running,stop as stop_tools,start as start_tools
    except ImportError:from scripts.tool_worker import running as tools_running,stop as stop_tools,start as start_tools
    from scripts.workflow_worker import running as workflows_running,stop as stop_workflows,start as start_workflows
    command=compose(state);env=environment(state)
    if output.exists(): raise ValueError('Backup destination already exists')
    output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    stage=Path(tempfile.mkdtemp(prefix='.backup-',dir=output.parent));stage.chmod(0o700)
    running=subprocess.check_output(command+['ps','--services','--status','running'],env=env,text=True).split()
    stopped=[name for name in SERVICES if name in running]
    tool_was_running=tools_running(state)
    workflow_was_running=workflows_running(state)
    try:
        if 'hermes' in stopped:subprocess.run(command+['stop','hermes'],env=env,check=True)
        if workflow_was_running:stop_workflows(state,wait=True)
        if tool_was_running:stop_tools(state,wait=True)
        # Stop ingress first; then writers. PostgreSQL remains available to pg_dump.
        for service in stopped:
            if service!='hermes':subprocess.run(command+['stop',service],env=env,check=True)
        manifest={'version':3,'created_at':datetime.now(timezone.utc).isoformat(),
                  'git_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                  'files':{},'recreated_plugin_links':[],'excluded_rebuildable_caches':[]}
        manifest['tables']=fingerprints(command,env)
        dump=stage/'archive.dump'
        with dump.open('xb') as file:
            subprocess.run(command+['exec','-T','postgres','pg_dump','-U','nocheh','-d','nocheh','-Fc','--no-owner'],env=env,stdout=file,check=True)
        dump.chmod(0o600);sync(dump);manifest['dump_sha256']=sha(dump)
        from scripts.workflow_recovery import enabled_or_present,snapshot as workflow_snapshot
        if enabled_or_present(state,env):
            manifest.update(version=4,workflows=workflow_snapshot(command,env,stage,sha))
        archive=stage/'state.tar.gz'
        with tarfile.open(archive,'w:gz',dereference=False) as tar:
            for name in ('.env','files','spool','hermes','provider','admin/jobs','admin/tools/receipts'):
                base=env_path(state) if name=='.env' else state/name
                if (name=='provider' or name.startswith('admin/')) and not base.exists(): continue
                candidates=[base]+sorted(base.rglob('*')) if base.is_dir() else [base]
                for path in candidates:
                    relative='.env' if name=='.env' else path.relative_to(state).as_posix()
                    cache=re.match(r'(hermes/(?:profiles/[^/]+/)?\.cache/uv)(?:/|$)',relative)
                    if cache:
                        # Native uv may create wheel-cache links. This exact
                        # dependency cache is rebuildable, never owned memory.
                        if cache[1] not in manifest['excluded_rebuildable_caches']:manifest['excluded_rebuildable_caches'].append(cache[1])
                        continue
                    if path.is_symlink():
                        if relative.endswith('plugins/nocheh'):
                            manifest['recreated_plugin_links'].append(relative);continue
                        raise ValueError('Unsupported state symlink: '+relative)
                    if path.is_dir(): continue
                    if not path.is_file(): raise ValueError('Missing/non-regular state file: '+relative)
                    manifest['files'][relative]={'sha256':sha(path),'size':path.stat().st_size}
                    tar.add(path,arcname='state/'+relative,recursive=False)
            # Provider reservations live outside the archive. Snapshot them with
            # SQLite's backup API; restoring Nocheh never resets the live ledger.
            ledger=ROOT/'data/honcho-experiment/ledger/budget.sqlite'
            if state.resolve()==(ROOT/'data/local').resolve() and ledger.is_file():
                copy=stage/'memory-budget.sqlite';source=sqlite3.connect(ledger.as_uri()+'?mode=ro',uri=True);target=sqlite3.connect(copy)
                try:source.backup(target);target.commit()
                finally:source.close();target.close()
                copy.chmod(0o600);relative='memory-ledger/budget.sqlite'
                manifest['files'][relative]={'sha256':sha(copy),'size':copy.stat().st_size}
                tar.add(copy,arcname='state/'+relative,recursive=False)
                copy.unlink()
        archive.chmod(0o600);sync(archive);manifest['state_sha256']=sha(archive)
        metadata=stage/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n');metadata.chmod(0o600);sync(metadata)
        stage.rename(output)
        descriptor=os.open(output.parent,os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
        return {'status':'backed_up','path':str(output),'files':len(manifest['files']),'tables':len(manifest['tables'])}
    finally:
        # Resume precisely the services that were running before the snapshot.
        if stopped and not leave_stopped: subprocess.run(command+['up','-d','--no-build','--wait','--wait-timeout','180']+stopped,env=env,check=True)
        if tool_was_running and not leave_stopped:start_tools(state)
        if workflow_was_running and not leave_stopped:start_workflows(state)


def validate_snapshot(snapshot):
    manifest=json.loads((snapshot/'manifest.json').read_text())
    if manifest.get('version') not in (1,2,3,4) or sha(snapshot/'archive.dump')!=manifest['dump_sha256'] or sha(snapshot/'state.tar.gz')!=manifest['state_sha256']:
        raise ValueError('Backup checksum mismatch')
    if manifest['version']==4:
        from scripts.workflow_recovery import validate
        validate(snapshot,manifest.get('workflows'),sha)
    seen=set()
    with tarfile.open(snapshot/'state.tar.gz','r:gz') as tar:
        for member in tar:
            parts=PurePosixPath(member.name).parts
            if not member.isfile() or len(parts)<2 or parts[0]!='state' or '..' in parts or PurePosixPath(member.name).is_absolute(): raise ValueError('Unsafe backup member')
            relative='/'.join(parts[1:])
            if relative in seen or relative not in manifest['files']: raise ValueError('Unexpected backup member')
            seen.add(relative);spec=manifest['files'][relative]
            digest=hashlib.sha256()
            with tar.extractfile(member) as file:
                for chunk in iter(lambda:file.read(1024*1024),b''): digest.update(chunk)
            if member.size!=spec['size'] or digest.hexdigest()!=spec['sha256']: raise ValueError('State file checksum mismatch')
    if seen!=set(manifest['files']): raise ValueError('Incomplete backup')
    return manifest


def restore(snapshot,state,project,port):
    if state.exists(): raise ValueError('Restore requires a new, nonexistent state directory')
    if not re.fullmatch(r'nocheh-[a-z0-9-]{3,50}',project) or project=='nocheh': raise ValueError('Use a new nocheh-* Compose project name')
    if subprocess.run(['docker','volume','inspect',project+'_postgres_data'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        raise ValueError('Restore project database volume already exists')
    manifest=validate_snapshot(snapshot)
    state.mkdir(parents=True,mode=0o700)
    with tarfile.open(snapshot/'state.tar.gz','r:gz') as tar:
        for member in tar:
            destination=state/PurePosixPath(member.name).relative_to('state')
            destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with tar.extractfile(member) as source,destination.open('xb') as target: shutil.copyfileobj(source,target)
            destination.chmod(0o600)
    for directory in ('reports','files','spool','hermes','provider','secrets'): (state/directory).mkdir(exist_ok=True,mode=0o700)
    # Retain the saved settings, but don't activate duplicate bot/OAuth owners.
    auth=state/'hermes/auth.json'
    if auth.exists(): auth.rename(state/'hermes/auth.restore-pending.json')
    provider_auth=state/'provider/auth'
    if provider_auth.is_dir() and any(provider_auth.iterdir()):
        provider_auth.rename(state/'provider/auth.restore-pending')
    from scripts.provider import initialize as initialize_provider
    initialize_provider(state)
    config=initialize(state) if manifest['version']==1 else load(state)
    write_env(state/'restored.env',config)
    config.update(TELEGRAM_ENABLED='false',NOCHEH_WORKFLOWS_ENABLED='false',NOCHEH_UID=str(os.getuid()),NOCHEH_GID=str(os.getgid()),NOCHEH_PORT=str(port),
                  NOCHEH_MEMORY_TOKEN='',NOCHEH_MEMORY_NETWORK=project+'-memory',NOCHEH_AGENT_NETWORK=project+'-agent')
    (state/'admin/tools').mkdir(parents=True,exist_ok=True,mode=0o700)
    (state/'admin/tools/inactive').touch()
    (state/'hermes/scheduler-inactive').touch()
    (state/'spool/.restore-inactive').touch()
    (state/'workflows').mkdir(parents=True,exist_ok=True,mode=0o700)
    (state/'workflows/inactive').touch()
    write_env(env_path(state),config)
    command=compose(state,project);env=environment(state)
    subprocess.run(command+['up','-d','--wait','postgres'],env=env,check=True)
    with (snapshot/'archive.dump').open('rb') as file:
        subprocess.run(command+['exec','-T','postgres','pg_restore','-U','nocheh','-d','nocheh','--no-owner','--exit-on-error'],env=env,stdin=file,check=True)
    # Old snapshots predate the policy tables; verify exactly their recorded set.
    actual=fingerprints(command,env,manifest['tables'])
    if actual!=manifest['tables']: raise RuntimeError('Restored database differs from the snapshot')
    if manifest.get('workflows'):
        from scripts.workflow_recovery import restore as restore_workflows
        restore_workflows(command,env,snapshot,state,manifest['workflows'],sha)
    if 'honcho_connection' in manifest['tables']:
        subprocess.run(command+['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh','-c',
            "UPDATE honcho_connection SET attached=false,verified=false; UPDATE guard_state SET epoch=epoch+1;"],env=env,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(command+['up','-d','--no-build','--wait','--wait-timeout','180'],env=env,check=True)
    result={'status':'restored_inactive','state':str(state),'project':project,'port':port,
            'verified_tables':list(actual),'verified_state_files':len(manifest['files']),
            'telegram_enabled':False,'subscription_login_activated':False}
    result['honcho_attached']=False
    result['executors_active']=False
    (state/'reports/restore.json').write_text(json.dumps(result,indent=2)+'\n')
    return result


def main(command,state,rest):
    parser=argparse.ArgumentParser(description=__doc__)
    if command=='diagnose':
        parser.parse_args(rest)
        rows=subprocess.check_output(compose(state)+['ps','--format','json'],env=environment(state),text=True)
        containers=[json.loads(line) for line in rows.splitlines() if line.strip()]
        result={'containers':[{'service':row['Service'],'state':row['State'],'health':row.get('Health')} for row in containers]}
        result['execution_holds']={
            'workflows':(state/'workflows/inactive').exists(),
            'workers':(state/'spool/.restore-inactive').exists(),
            'tools':(state/'admin/tools/inactive').exists(),
            'scheduler':(state/'hermes/scheduler-inactive').exists(),
            'subscription_login':(state/'hermes/auth.restore-pending.json').exists() or (state/'provider/auth.restore-pending').exists(),
        }
        config=load(state)
        port=int(config.get('NOCHEH_PORT','8780'))
        request=urllib.request.Request(f'http://127.0.0.1:{port}/v1/status',headers={'Authorization':'Bearer '+config['SERVICE_TOKEN']})
        try:
            with urllib.request.urlopen(request,timeout=10) as response: result['archive']=json.load(response)
        except Exception as error: result['archive']={'error':type(error).__name__}
        try:
            raw=subprocess.check_output(compose(state)+['exec','-T','hermes','python','-c',
                "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8781/health',timeout=5))))"],env=environment(state),text=True)
            result['hermes']=json.loads(raw)
        except Exception as error: result['hermes']={'error':type(error).__name__}
    elif command=='backup':
        parser.add_argument('--output',type=Path,default=ROOT/'data/backups'/time.strftime('%Y%m%d-%H%M%S'))
        parser.add_argument('--leave-stopped',action='store_true',help='Keep writers stopped for a planned cutover')
        args=parser.parse_args(rest);result=backup(state,args.output.resolve(),args.leave_stopped)
    else:
        parser.add_argument('snapshot',type=Path);parser.add_argument('--state',type=Path,required=True)
        parser.add_argument('--project',required=True);parser.add_argument('--port',type=int,default=8795)
        args=parser.parse_args(rest)
        if not 1024<=args.port<=65535: parser.error('Port must be between 1024 and 65535')
        result=restore(args.snapshot.resolve(),args.state.resolve(),args.project,args.port)
    print(json.dumps(result,indent=2));return 0
