"""Quiesced fault-fixture recovery; refuses the active installation and existing targets."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from .configuration import read_env
from .operations import sha,sync
from .workflow_recovery import snapshot,restore

ROOT=Path(__file__).resolve().parents[1]


def archive_fingerprints(command,env,schema):
    prefix=command+['exec','-T','nocheh-postgres','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh','-d','nocheh']
    names=subprocess.check_output(prefix+['-c',f"SELECT tablename FROM pg_tables WHERE schemaname='{schema}' ORDER BY 1"],env=env,text=True).split()
    import hashlib
    result={}
    for name in names:
        if not re.fullmatch('[a-z_]+',name):raise ValueError('fixture_table_invalid')
        query=f'COPY (SELECT row_to_json(t) FROM {schema}.{name} t ORDER BY row_to_json(t)::text) TO STDOUT'
        value=subprocess.check_output(prefix+['-c',query],env=env)
        result[name]=hashlib.sha256(value).hexdigest()
    return result


def main(env_file,destination):
    source=read_env(env_file);project=source.get('NOCHEH_FIXTURE_PROJECT','');schema=source.get('NOCHEH_FAULT_SCHEMA','')
    state=Path(source.get('NOCHEH_FAULT_STATE','/')).resolve();destination=destination.resolve()
    if not re.fullmatch('nocheh-inngest-fault-[a-f0-9]+',project) or not re.fullmatch('fault_[a-f0-9]+',schema):raise ValueError('synthetic_fault_fixture_required')
    if not state.is_relative_to(ROOT/'data') or state==(ROOT/'data/local') or not destination.is_relative_to(ROOT/'data') or destination.is_relative_to(state) or destination.exists():raise ValueError('fresh_fixture_destination_required')
    environment=dict(os.environ)
    base=['docker','compose','--env-file',str(env_file.resolve()),'-f',str(ROOT/'compatibility/inngest-compose.yml')]
    command=base+['-f',str(ROOT/'compatibility/inngest-fault-compose.yml')]
    running=subprocess.check_output(command+['ps','--services','--status','running'],env=environment,text=True).split()
    writers=[name for name in ['fault-runtime','fault-worker','fault-publisher','inngest-server'] if name in running]
    destination.mkdir(mode=0o700);backup=destination/'snapshot';backup.mkdir(mode=0o700)
    target_state=destination/'state';target_env={**source,'NOCHEH_FIXTURE_PROJECT':project+'-recovery','NOCHEH_FAULT_STATE':str(target_state),'NOCHEH_WORKFLOWS_ENABLED':'false'}
    target_file=destination/'.env';target_file.write_text('\n'.join(k+'='+v for k,v in target_env.items())+'\n');target_file.chmod(0o600)
    restored=['docker','compose','--env-file',str(target_file),'-f',str(ROOT/'compatibility/inngest-compose.yml'),'-f',str(ROOT/'compatibility/inngest-restore-compose.yml')]
    try:
        if writers:subprocess.run(command+['stop',*writers],env=environment,check=True)
        metadata=snapshot(command,environment,backup,sha)
        archive=archive_fingerprints(command,environment,schema)
        dump=backup/'archive.dump'
        with dump.open('xb') as output:
            dump.chmod(0o600);subprocess.run(command+['exec','-T','nocheh-postgres','pg_dump','-U','nocheh','-d','nocheh','-Fc','--no-owner'],env=environment,stdout=output,check=True)
        sync(dump)
        files={str(path.relative_to(state)):sha(path) for path in state.rglob('*') if path.is_file()}
        shutil.copytree(state,target_state)
        subprocess.run(restored+['up','-d','--wait','--no-build','nocheh-postgres'],env=environment,check=True)
        result=restore(restored,environment,backup,target_state,metadata,sha)
        with dump.open('rb') as source_dump:
            subprocess.run(restored+['exec','-T','nocheh-postgres','pg_restore','-U','nocheh','-d','nocheh','--no-owner','--exit-on-error'],env=environment,stdin=source_dump,check=True)
        if archive_fingerprints(restored,environment,schema)!=archive:raise RuntimeError('fixture_archive_mismatch')
        if any(sha(target_state/path)!=value for path,value in files.items()):raise RuntimeError('fixture_file_mismatch')
        (target_state/'spool/.restore-inactive').touch();(target_state/'workflows/inactive').touch()
        subprocess.run(restored+['up','-d','--wait','--no-build','inngest-redis'],env=environment,check=True)
        redis_count=int(subprocess.check_output(restored+['exec','-T','inngest-redis','redis-cli','dbsize'],env=environment,text=True).strip())
        subprocess.run(restored+['restart','nocheh-postgres','inngest-redis'],env=environment,check=True)
        subprocess.run(restored+['up','-d','--wait','--no-build','nocheh-postgres','inngest-redis'],env=environment,check=True)
        if archive_fingerprints(restored,environment,schema)!=archive:raise RuntimeError('fixture_restart_archive_mismatch')
        from .workflow_recovery import fingerprints
        if fingerprints(restored,environment)!=metadata['tables']:raise RuntimeError('fixture_restart_workflow_mismatch')
        services=subprocess.check_output(restored+['ps','--services','--status','running'],env=environment,text=True).split()
        if set(services)!={'nocheh-postgres','inngest-redis'}:raise RuntimeError('restored_executor_active')
        result.update(archive_tables=len(archive),workflow_tables=len(metadata['tables']),protected_files=len(files),redis_keys=redis_count,
                      archive_dump_sha256=sha(dump),redis_snapshot_bytes=metadata['workflow-redis.rdb']['size'],restart_verified=True)
        (destination/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    finally:
        if writers:subprocess.run(command+['start',*writers],env=environment,check=True)


if __name__=='__main__':main(Path(sys.argv[1]),Path(sys.argv[2]))
