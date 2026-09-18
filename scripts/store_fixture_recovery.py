"""Exercise three-store recovery in fresh, synthetic-only Compose resources."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from .configuration import read_env
from .operations import sha
from .store_recovery import StoreRecovery

ROOT=Path(__file__).resolve().parents[1]


def main(env_file,destination):
    source=read_env(env_file);project=source.get('NOCHEH_STORES_FIXTURE_PROJECT','')
    if not re.fullmatch(r'nocheh-stores-[a-z0-9-]+',project) or destination.exists():raise ValueError('fresh_synthetic_recovery_required')
    command=['docker','compose','--env-file',str(env_file),'-f',str(ROOT/'compatibility/stores-compose.yml')]
    environment=dict(os.environ);recovery=StoreRecovery(command,environment,'database')
    if recovery.query(None,"SELECT current_setting('cluster_name')").strip()!='nocheh-stores-fixture':raise ValueError('synthetic_cluster_required')
    services=subprocess.check_output(command+['ps','--services','--status','running'],text=True).split()
    if set(services)-{'database','inngest-server','inngest-redis'}:raise ValueError('fixture_writers_must_be_stopped')
    target_project=project+'-restore'
    if subprocess.run(['docker','volume','inspect',target_project+'_stores_fixture_database'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        raise ValueError('fresh_fixture_volume_required')
    destination.mkdir(mode=0o700);snapshot=destination/'snapshot';snapshot.mkdir(mode=0o700)
    target_file=destination/'target.env';target_file.write_text('\n'.join(k+'='+v for k,v in {**source,'NOCHEH_STORES_FIXTURE_PROJECT':target_project}.items())+'\n');target_file.chmod(0o600)
    target=['docker','compose','--env-file',str(target_file),'-f',str(ROOT/'compatibility/stores-compose.yml')]
    with recovery.maintenance(),recovery.barrier():
        contender=StoreRecovery(command,environment,'database')
        try:
            with contender.maintenance():raise AssertionError('concurrent_maintenance_admitted')
        except RuntimeError as error:
            if str(error)!='store_maintenance_busy':raise
        try:recovery.query('control',"SET lock_timeout='200ms'; UPDATE guard_state SET epoch=epoch")
        except subprocess.CalledProcessError:pass
        else:raise AssertionError('barrier_did_not_block_writes')
        metadata=recovery.snapshot(snapshot,sha)
    (snapshot/'stores.json').write_text(json.dumps(metadata,indent=2)+'\n');(snapshot/'stores.json').chmod(0o600)
    # A failure while establishing the third lock must release the first two.
    names=recovery.names
    def fail_third(store,*args):
        if store=='control':raise RuntimeError('injected-barrier-interruption')
        return names(store,*args)
    try:
        with patch.object(recovery,'names',side_effect=fail_third),recovery.barrier():raise AssertionError('injection_missing')
    except RuntimeError as error:
        if str(error)!='injected-barrier-interruption':raise
    recovery.query('archive',"BEGIN; SET LOCAL lock_timeout='200ms'; LOCK TABLE events IN ACCESS EXCLUSIVE MODE; ROLLBACK")
    subprocess.run(target+['up','-d','--wait','--no-build','database'],env=environment,check=True)
    restored=StoreRecovery(target,environment,'database')
    if restored.query(None,"SELECT current_setting('cluster_name')").strip()!='nocheh-stores-fixture':raise ValueError('synthetic_restore_cluster_required')
    result=restored.restore_inactive(snapshot,metadata,sha)
    if restored.query(None,"SELECT count(*) FROM pg_roles WHERE rolname IN ('nocheh_archive','nocheh_derived','nocheh_control') AND rolcanlogin").strip()!='0':raise AssertionError('runtime_login_enabled')
    count=int(restored.query('derived',"SELECT count(*) FROM guard_revisions WHERE author='owner'"))
    if count<1:raise AssertionError('owner_guarded_history_missing')
    if restored.query('control','SELECT epoch FROM guard_state').strip()!=str(int(recovery.query('control','SELECT epoch FROM guard_state'))+1):raise AssertionError('old_capabilities_not_revoked')
    subprocess.run(target+['restart','database'],env=environment,check=True)
    subprocess.run(target+['up','-d','--wait','--no-build','database'],env=environment,check=True)
    for store in ('archive','derived'):
        expected=metadata['databases'][store]
        if restored.fingerprints(store)!={k:expected[k] for k in ('tables','sequences')}:raise AssertionError('restart_changed_content')
    running=subprocess.check_output(target+['ps','--services','--status','running'],env=environment,text=True).split()
    if running!=['database']:raise AssertionError('restore_started_executor')
    result.update(source_project=project,restore_project=target_project,barrier_blocks_writes=True,
        partial_barrier_releases=True,maintenance_serialized=True,owner_guarded_revisions=count,restart_verified=True,
        tables={k:len(v['tables']) for k,v in metadata['databases'].items()},live_data_changed=False)
    (destination/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve())
