"""Exercise reset shutdown on real Compose owners and PostgreSQL maintenance.

Writers are synthetic heartbeat processes. This verifies shutdown ownership and
restart recovery, not native/provider behavior or complete installation acceptance.
"""
import argparse
import copy
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import configuration, reset_inventory, reset_protocol, reset_quiescence
from scripts.store_recovery import StoreRecovery

WRITER = '''import os,signal,time
from pathlib import Path
running=True
def stop(*_):
 global running
 running=False
signal.signal(signal.SIGTERM,stop)
path=Path('/fixture')/os.environ['RESET_FIXTURE_ROLE']
while running:
 path.write_text(str(time.time_ns()))
 time.sleep(.1)
path.write_text('stopped')
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--management-image',required=True)
    args=parser.parse_args();directory=args.directory.resolve();directory.mkdir(mode=0o700)
    installation=directory/'installation';installation.mkdir();state=directory/'state'
    project='nocheh-reset-stop-'+uuid.uuid4().hex[:12];sentinel=project+'-sentinel'
    config=configuration.initialize(state);config.update(COMPOSE_PROJECT_NAME=project)
    configuration.write_env(state/'.env',config)
    writers=('hermes','nocheh-executor','hermes-agent-sb','nocheh-app','nocheh-security',
             'nocheh-dashboard','honcho-deriver','cliproxy-api')
    services={'nocheh-db': {
        'image':'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
        'restart':'unless-stopped', 'command':['postgres','-c','cluster_name=nocheh-reset-quiescence-fixture'],
        'environment':{'POSTGRES_DB':'nocheh','POSTGRES_USER':'nocheh','POSTGRES_PASSWORD':'synthetic-shutdown-not-a-real-credential'},
        'volumes':['postgres_data:/var/lib/postgresql/data'],
        'healthcheck':{'test':['CMD','pg_isready','-U','nocheh','-d','nocheh'],'interval':'1s','timeout':'2s','retries':30}}}
    for service in writers:
        services[service]={'image':args.management_image,'restart':'unless-stopped','network_mode':'none','read_only':True,
            'user':str(os.getuid())+':'+str(os.getgid()),'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],
            'entrypoint':['python3','-c',WRITER],'environment':{'RESET_FIXTURE_ROLE':service},
            'volumes':[str(state/'reports')+':/fixture'],'tmpfs':['/tmp'],
            'healthcheck':{'test':['CMD','python3','-c',"import os;from pathlib import Path;assert (Path('/fixture')/os.environ['RESET_FIXTURE_ROLE']).is_file()"],
                           'interval':'1s','timeout':'2s','retries':30}}
    compose=installation/'docker-compose.yml'
    compose.write_text(json.dumps({'name':project,'services':services,'volumes':{'postgres_data':{}},'networks':{'default':{'internal':True}}}))
    compose.chmod(0o600)
    sentinel_file=directory/'sentinel.yml'
    sentinel_file.write_text(json.dumps({'services':{'unrelated':{'image':args.management_image,'restart':'unless-stopped',
        'network_mode':'none','read_only':True,'entrypoint':['python3','-c','import time;time.sleep(3600)']}}}))
    side=['docker','compose','-p',sentinel,'-f',str(sentinel_file)]
    foreign=None;owned=None
    try:
        with patch.object(configuration,'INSTALLATION_ROOT',installation):
            command=configuration.compose_command(state);environment=configuration.compose_environment(state)
            rendered=json.loads(subprocess.check_output(command+['config','--format','json'],env=environment,text=True))
            assert rendered['networks']['default']['internal']
            assert all(not service.get('ports') for service in rendered['services'].values())
            owned=command
            subprocess.run(command+['up','-d','--no-build','--wait'],env=environment,check=True)
            subprocess.run(side+['up','-d','--no-build'],check=True)
            sentinel_id=subprocess.check_output(side+['ps','-q','unrelated'],text=True).strip()
            inspect=lambda:reset_inventory.inspect(state,root=installation)
            preflight=inspect();assert preflight['blockers']==[],preflight['blockers']
            identifiers={row['id'] for row in preflight['containers']};mutations=[]
            recovery=StoreRecovery(command,environment)
            assert recovery.query(None,'SHOW cluster_name').strip()=='nocheh-reset-quiescence-fixture'
            generation=str(uuid.uuid4())
            def run(arguments,env):
                selected=arguments[3:] if arguments[1]=='update' else arguments[4:]
                assert set(selected)<=identifiers
                reset_quiescence.run(arguments,env);mutations.append(arguments[1])
            def interrupted(arguments,env):
                run(arguments,env)
                if len(mutations)==1:raise RuntimeError('simulated coordinator interruption')
            with reset_protocol.locked(state) as journal,recovery.maintenance():
                journal.create(preflight,generation)
                # This evidence admits only this bounded synthetic fixture.
                journal.complete('isolated_acceptance',reset_protocol.fingerprint({'fixture':project,'network':'none-or-internal'}))
                try:
                    reset_quiescence.quiesce(journal,preflight,recovery.assert_maintenance,inspect=inspect,runner=interrupted,environment=environment)
                except RuntimeError as error:assert str(error)=='simulated coordinator interruption'
                else:raise AssertionError('interruption not exercised')
                original=(journal.directory/'quiescence.json').read_bytes()
                assert journal.value['steps'][-1]['step']=='isolated_acceptance'
            # A different coordinator process would reacquire both locks here.
            with reset_protocol.locked(state) as journal,recovery.maintenance():
                try:
                    with StoreRecovery(command,environment).maintenance():pass
                except RuntimeError as error:assert str(error)=='store_maintenance_busy'
                else:raise AssertionError('database maintenance exclusion failed')
                inspections=0
                def inspect_with_foreign_writer():
                    nonlocal inspections,foreign
                    inspections+=1
                    if inspections==2:
                        foreign=subprocess.check_output(['docker','run','-d','--name',project+'-foreign','--network=none','--read-only',
                            '--mount','type=bind,src='+str(state/'reports')+',dst=/fixture',
                            '--entrypoint','python3',args.management_image,'-c','import time;time.sleep(3600)'],text=True).strip()
                    return inspect()
                try:
                    reset_quiescence.quiesce(journal,preflight,recovery.assert_maintenance,inspect=inspect_with_foreign_writer,runner=run,environment=environment)
                except RuntimeError as error:assert str(error)=='reset_installation_ownership_changed'
                else:raise AssertionError('foreign writer did not block completion')
                assert journal.value['steps'][-1]['step']=='isolated_acceptance'
                subprocess.run(['docker','rm','-f',foreign],check=True,stdout=subprocess.DEVNULL);foreign=None
                result=reset_quiescence.quiesce(journal,preflight,recovery.assert_maintenance,inspect=inspect,runner=run,environment=environment)
                assert result['remaining_services']==['nocheh-db']
                assert (journal.directory/'quiescence.json').read_bytes()==original
                reset_quiescence.verify_quiescent(journal,preflight,inspect())
                assert recovery.query(None,'SELECT 1').strip()=='1'
                assert all((state/'reports'/service).read_text()=='stopped' for service in writers)
            before={p.name:p.read_bytes() for p in (state/'reports').iterdir()}
            time.sleep(2)
            assert before=={p.name:p.read_bytes() for p in (state/'reports').iterdir()}
            after=json.loads(subprocess.check_output(['docker','inspect','--format',reset_inventory.CONTAINER_FORMAT,sentinel_id],text=True))
            assert after['state']=='running' and after['restart_policy']['Name']=='unless-stopped'
            report={'passed':True,'project':project,'reviewed_containers':len(identifiers),'synthetic_writers_stopped':len(writers),
                'maintenance_exclusion':True,'interrupted_shutdown_recovered':True,'foreign_writer_blocks_completion':True,
                'original_restart_settings_preserved':True,'restart_suppressed':True,'inactive_fences_retained':True,
                'remaining_services':['nocheh-db'],'unrelated_sentinel_unchanged':True,'provider_calls':0,'live_state_changed':False,
                'fixture_kind':'real Compose lifecycle and PostgreSQL lock with synthetic heartbeat writers; not full installation acceptance'}
            (directory/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    finally:
        if foreign:subprocess.run(['docker','rm','-f',foreign],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(side+['down'],check=True)
        if owned:subprocess.run(owned+['down','--volumes'],env=environment,check=True)


if __name__=='__main__':main()
