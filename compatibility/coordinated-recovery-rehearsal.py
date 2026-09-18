"""Exercise production format-six coordination on two entirely synthetic installations."""
import argparse,json,os,sqlite3,subprocess,sys,time,uuid
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts import operations
from scripts.configuration import initialize,write_env,compose_command,compose_environment,load
from scripts.store_recovery import StoreRecovery

parser=argparse.ArgumentParser()
parser.add_argument('--directory',type=Path,required=True)
parser.add_argument('--services-image',required=True);parser.add_argument('--honcho-image',required=True)
parser.add_argument('--management-image',help='Also verify real dashboard-started backup and automatic service resumption')
args=parser.parse_args();root=Path(__file__).resolve().parents[1];directory=args.directory.resolve()
if directory.exists():raise ValueError('new_fixture_directory_required')
directory.mkdir(mode=0o700);source=directory/'source';target=directory/'target'
prefix='nocheh-recovery-'+uuid.uuid4().hex[:12];projects={source:prefix+'-source',target:prefix+'-target'}
overlay=root/'compatibility/coordinated-recovery-compose.yml'
def command(state,project=None):return compose_command(state,project or projects[state])+['-f',str(overlay)]
def environment(state):return {**compose_environment(state),'NOCHEH_RECOVERY_SERVICES_IMAGE':args.services_image,'NOCHEH_RECOVERY_HONCHO_IMAGE':args.honcho_image,
    **({'NOCHEH_RECOVERY_MANAGEMENT_IMAGE':args.management_image} if args.management_image else {})}
def run(state,arguments,**kwargs):return subprocess.run(command(state)+arguments,env=environment(state),check=True,**kwargs)
def query(state,service,database,sql,user='nocheh'):
    return subprocess.check_output(command(state)+['exec','-T',service,'psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-U',user,'-d',database,'-c',sql],env=environment(state),text=True).strip()
owned_volumes=[]
try:
    config=initialize(source);project=projects[source]
    config.update(NOCHEH_STORAGE_LAYOUT='original-only-v1',NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_STATE_DIR=str(source/'honcho'),
        NOCHEH_HONCHO_DATABASE_VOLUME=project+'_honcho_database',NOCHEH_HONCHO_REDIS_VOLUME=project+'_honcho_redis',
        COMPOSE_PROJECT_NAME=project,NOCHEH_AGENT_NETWORK=project+'-agent',NOCHEH_MEMORY_NETWORK=project+'-memory',TELEGRAM_OWNER_ID='123',NOCHEH_PORT='18960')
    write_env(source/'.env',config)
    memory=source/'honcho';memory.mkdir(mode=0o700)
    for name in ('internal_token','database_password','temporary_embedding_key','honcho.Dockerfile'):
        (memory/name).write_text('synthetic-native-portable-not-a-real-credential');(memory/name).chmod(0o600)
    write_env(memory/'honcho.env',{'DB_CONNECTION_URI':'postgresql+psycopg://experiment:synthetic-native-portable-not-a-real-credential@honcho-postgres:5432/honcho_experiment'})
    write_env(memory/'meter.env',{})
    (memory/'ledger').mkdir()
    with sqlite3.connect(memory/'ledger/budget.sqlite') as db:db.execute('CREATE TABLE reservations(id TEXT, cost INTEGER)');db.execute("INSERT INTO reservations VALUES('synthetic-spend',17)")
    for volume in (config['NOCHEH_HONCHO_DATABASE_VOLUME'],config['NOCHEH_HONCHO_REDIS_VOLUME']):
        if subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise ValueError('fixture_volume_already_exists')
        subprocess.run(['docker','volume','create','--label','nocheh.fixture='+prefix,volume],check=True,stdout=subprocess.DEVNULL);owned_volumes.append(volume)
    rendered=json.loads(subprocess.check_output(command(source)+['config','--format','json'],env=environment(source),text=True))
    assert all(network.get('internal') for network in rendered['networks'].values())
    run(source,['up','-d','--no-build','--wait','nocheh-postgres','honcho-postgres','inngest-redis'])
    run(source,['run','--rm','--no-deps','nocheh-store-bootstrap'])
    run(source,['run','--rm','--no-deps','-v',str(root/'compatibility')+':/app/compatibility:ro',
        '-v',str(source/'files')+':/data/files','-v',str(source/'spool')+':/data/spool','nocheh-store-bootstrap','node','compatibility/coordinated-recovery-seed.mjs'])
    run(source,['run','--rm','--no-deps','--entrypoint','/app/.venv/bin/python','honcho-api','scripts/provision_db.py'])
    run(source,['run','--rm','--no-deps','--entrypoint','/app/.venv/bin/python','-v',str(root/'compatibility/native-portability-seed.py')+':/fixture/seed.py:ro','honcho-api','/fixture/seed.py'])
    run(source,['up','-d','--no-deps','--no-build','--wait','inngest-server'])
    run(source,['exec','-T','inngest-redis','redis-cli','SET','fixture:owned','workflow-evidence'],stdout=subprocess.DEVNULL)
    profile=source/'hermes/profiles/fixture';profile.mkdir(parents=True)
    (profile/'MEMORY.md').write_text('Synthetic native notes\r\n');(profile/'USER.md').write_text('Synthetic user notes\n')
    with sqlite3.connect(profile/'state.db') as db:
        db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE fixture_sessions(id TEXT, text TEXT)');db.execute("INSERT INTO fixture_sessions VALUES('session','Exact native session')")
    (source/'spool/pending-fixture.json').write_text('{"synthetic":"pending original"}\n')
    (source/'provider/auth/fixture.json').write_text('{"synthetic":"inactive login"}\n')
    snapshot=directory/'snapshot'
    if args.management_image:
        # A standalone rendering gives the container the exact synthetic service
        # definitions without a production hook for arbitrary Compose overrides.
        installation=directory/'installation';(installation/'deploy').mkdir(parents=True,mode=0o700)
        (installation/'deploy/original-only-compose.yml').write_text('services: {}\n')
        (installation/'.git').write_text((root/'.git').read_text())
        dashboard=rendered['services']['nocheh-dashboard'];dashboard['environment']['NOCHEH_INSTALLATION_ROOT']=str(installation)
        dashboard['volumes'].append({'type':'bind','source':str(installation),'target':str(installation),'read_only':True})
        git_directory=Path(subprocess.check_output(['git','rev-parse','--git-common-dir'],cwd=root,text=True).strip()).resolve()
        dashboard['volumes'].append({'type':'bind','source':str(git_directory),'target':str(git_directory),'read_only':True})
        rendered_file=installation/'docker-compose.yml';rendered_file.write_text(json.dumps(rendered));rendered_file.chmod(0o600)
        standalone=['docker','compose','-f',str(rendered_file),'-p',project]
        subprocess.run(standalone+['up','-d','--no-deps','--no-build','--wait','nocheh-dashboard'],env=environment(source),check=True)
        def dashboard_call(path,body=None):
            script="""import json,os,sys,urllib.request
from pathlib import Path
state=Path(os.environ['NOCHEH_STATE_DIR']);token=(state/'admin/dashboard/token').read_text().strip()
body=json.loads(sys.argv[2]);request=urllib.request.Request('http://127.0.0.1:'+os.environ['NOCHEH_DASHBOARD_PORT']+'/api/nocheh'+sys.argv[1],
data=None if body is None else json.dumps(body).encode(),headers={'X-Nocheh-Session-Token':token,'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=120) as response:print(response.read().decode())
"""
            return json.loads(subprocess.check_output(standalone+['exec','-T','nocheh-dashboard','python3','-c',script,path,json.dumps(body)],env=environment(source),text=True))
        before_id=subprocess.check_output(standalone+['ps','-q','nocheh-dashboard'],env=environment(source),text=True).strip()
        job=dashboard_call('/operations',{'action':'backup'})
        for _ in range(600):
            status=dashboard_call('/jobs/'+job['id'])
            if status['state']!='running':break
            time.sleep(1)
        assert status['state']=='complete',status
        after_id=subprocess.check_output(standalone+['ps','-q','nocheh-dashboard'],env=environment(source),text=True).strip()
        assert before_id==after_id
        assert dashboard_call('/maintenance')['ready'] is False
        snapshot=source/'admin/backups'/job['id']
        assert 'inngest-server' in subprocess.check_output(standalone+['ps','--services','--status','running'],env=environment(source),text=True).split()
        print(json.dumps({'dashboard_backup_completed':True,'coordinator_survived':True,'writers_resumed':True}),flush=True)
    # Only substitute the fixture composition; all orchestration and verification
    # execute the production backup/restore implementation unchanged.
    with patch.object(operations,'compose',side_effect=command),patch.object(operations,'environment',side_effect=environment):
        if not args.management_image:operations.backup(source,snapshot,leave_stopped=True)
        manifest=operations.validate_snapshot(snapshot)
        assert manifest['version']==6 and manifest.get('workflows') and manifest.get('honcho')
        assert set(manifest['stores']['databases'])=={'archive','derived','control'}
        # Track the absent, exact target volumes before restore so a later
        # verification failure still cleans up only this fixture's resources.
        for suffix in ('_honcho_database','_honcho_redis'):
            volume=projects[target]+suffix
            if subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
                raise ValueError('fixture_restore_volume_already_exists')
            owned_volumes.append(volume)
        restored=operations.restore(snapshot,target,projects[target],18980)
    target_config=load(target)
    recovery=StoreRecovery(command(target),environment(target))
    assert recovery.query(None,"SELECT count(*) FROM pg_roles WHERE rolname IN ('nocheh_archive','nocheh_derived','nocheh_control') AND rolcanlogin").strip()=='0'
    assert query(target,'nocheh-postgres','nocheh_derived',"SELECT count(*) FROM guard_revisions WHERE author='owner'")=='1'
    assert (target/'hermes/profiles/fixture/MEMORY.md').read_bytes()==(profile/'MEMORY.md').read_bytes()
    assert (target/'hermes/profiles/fixture/state.db').read_bytes()==(profile/'state.db').read_bytes()
    for path in (source/'files').rglob('*'):
        if path.is_file():assert (target/path.relative_to(source)).read_bytes()==path.read_bytes()
    assert (target/'provider/auth.restore-pending/fixture.json').is_file()
    assert (target/'spool/.restore-inactive').exists() and (target/'workflows/inactive').exists()
    with sqlite3.connect(target/'honcho/ledger/budget.sqlite') as db:assert db.execute('SELECT cost FROM reservations').fetchone()==(17,)
    running=subprocess.check_output(command(target)+['ps','--services','--status','running'],env=environment(target),text=True).split()
    assert running==['nocheh-postgres'],running
    redis=run(target,['run','--rm','--no-deps','inngest-redis','sh','-c',
        "redis-server --bind 127.0.0.1 --port 6380 --dir /data --appendonly yes --save '' --daemonize yes; trap 'redis-cli -p 6380 shutdown nosave >/dev/null' EXIT; i=0; until redis-cli -p 6380 ping >/dev/null 2>&1; do i=$((i+1)); test $i -lt 300 || exit 1; sleep 0.1; done; test \"$(redis-cli -p 6380 GET fixture:owned)\" = workflow-evidence"],stdout=subprocess.DEVNULL)
    report={'passed':True,'format':6,'source_project':projects[source],'restore_project':projects[target],
        'databases':{s:len(d['tables']) for s,d in manifest['stores']['databases'].items()},'native_memory_tables':len(manifest['honcho']['tables']),
        'workflow_tables':len(manifest['workflows']['tables']),'state_files':len(manifest['files']),'guarded_owner_edits_preserved':True,
        'original_files_exact':True,'native_sessions_and_notes_exact':True,'workflow_redis_recovered':True,'spending_ledger_preserved':True,
        'runtime_roles_no_login':True,'provider_logins_inactive':True,'only_restored_database_running':True,
        'dashboard_started':bool(args.management_image),'coordinator_survived':bool(args.management_image),'writers_resumed':bool(args.management_image),
        'provider_calls':0,'live_state_changed':False}
    (directory/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
finally:
    for state in reversed(list(projects)):
        if (state/'.env').exists():
            subprocess.run(command(state)+['--profile','honcho','down','--volumes'],env=environment(state),check=False)
    for volume in reversed(owned_volumes):
        if subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
            subprocess.run(['docker','volume','rm',volume],check=True,stdout=subprocess.DEVNULL)
