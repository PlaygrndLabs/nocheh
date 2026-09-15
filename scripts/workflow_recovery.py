"""Quiesced Inngest metadata and Redis snapshots; no runtime activation."""
import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

DATABASE='nocheh_inngest'

# Daemonization returns before Redis has necessarily loaded the RDB or opened
# its listener. Wait for readiness before enabling the replacement AOF.
REDIS_RESTORE_SCRIPT='''set -eu
redis-server --bind 127.0.0.1 --port 6380 --dir /data --appendonly no --save '' --daemonize yes --pidfile /tmp/nocheh-restore.pid --logfile /tmp/nocheh-restore.log
trap 'redis-cli -p 6380 shutdown nosave >/dev/null 2>&1 || true' EXIT
i=0
while [ "$(redis-cli -p 6380 ping 2>/dev/null || true)" != PONG ]; do
  i=$((i+1)); test "$i" -lt 300; sleep 0.1
done
[ "$(redis-cli -p 6380 config set appendonly yes)" = OK ]
i=0
while ! redis-cli -p 6380 info persistence | tr -d '\\r' | grep -q '^aof_rewrite_in_progress:0$'; do
  i=$((i+1)); test "$i" -lt 300; sleep 0.1
done
redis-cli -p 6380 info persistence | tr -d '\\r' | grep -q '^aof_last_bgrewrite_status:ok$'
redis-cli -p 6380 shutdown nosave >/dev/null
trap - EXIT
'''


def fingerprints(command,env,tables=None):
    prefix=command+['exec','-T','postgres','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh','-d',DATABASE]
    if tables is None:
        raw=subprocess.check_output(prefix+['-c',"SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1"],env=env,text=True)
        tables=raw.split()
    if any(not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*',t) for t in tables):raise ValueError('workflow_snapshot_table_invalid')
    result={}
    for table in tables:
        relation='.'.join('"'+part+'"' for part in table.split('.'))
        query=f'COPY (SELECT row_to_json(t) FROM {relation} t ORDER BY row_to_json(t)::text) TO STDOUT'
        process=subprocess.Popen(prefix+['-c',query],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        digest=hashlib.sha256()
        for chunk in iter(lambda:process.stdout.read(1024*1024),b''):digest.update(chunk)
        if process.wait():raise RuntimeError('workflow_snapshot_fingerprint_failed')
        result[table]=digest.hexdigest()
    return result


def enabled_or_present(state,env):
    return env.get('NOCHEH_WORKFLOWS_ENABLED')=='true' or (Path(state)/'workflows/redis').exists()


def snapshot(command,env,stage,sha):
    # Caller has stopped execution/publishing authorities and Inngest. Redis is
    # still up solely to export its quiesced dataset as a portable RDB.
    result={'version':1,'tables':fingerprints(command,env)}
    for filename,args in (
        ('inngest.dump',['postgres','pg_dump','-U','nocheh','-d',DATABASE,'-Fc','--no-owner']),
        ('workflow-redis.rdb',['workflow-redis','redis-cli','--rdb','-']),
    ):
        path=Path(stage)/filename
        with path.open('xb') as output:
            path.chmod(0o600)
            subprocess.run(command+['exec','-T',*args],env=env,stdout=output,stderr=subprocess.DEVNULL,check=True)
            output.flush();os.fsync(output.fileno())
        result[filename]={'sha256':sha(path),'size':path.stat().st_size}
    return result


def validate(directory,metadata,sha):
    if not isinstance(metadata,dict) or metadata.get('version')!=1:raise ValueError('workflow_snapshot_version_invalid')
    for filename in ('inngest.dump','workflow-redis.rdb'):
        path=Path(directory)/filename;record=metadata.get(filename,{})
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=record.get('size') or sha(path)!=record.get('sha256'):
            raise ValueError('workflow_snapshot_checksum_mismatch')
    if not isinstance(metadata.get('tables'),dict) or any(not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*',t) for t in metadata['tables']):
        raise ValueError('workflow_snapshot_table_invalid')


def restore(command,env,snapshot_dir,state,metadata,sha):
    validate(snapshot_dir,metadata,sha)
    subprocess.run(command+['run','--rm','--no-deps','workflow-database'],env=env,check=True,stdout=subprocess.DEVNULL)
    with (Path(snapshot_dir)/'inngest.dump').open('rb') as source:
        subprocess.run(command+['exec','-T','postgres','pg_restore','-U','nocheh','-d',DATABASE,'--role=nocheh_inngest','--no-owner','--exit-on-error'],env=env,stdin=source,check=True,stdout=subprocess.DEVNULL)
    if fingerprints(command,env,metadata['tables'])!=metadata['tables']:raise RuntimeError('workflow_restore_fingerprint_mismatch')
    directory=Path(state)/'workflows/redis';directory.mkdir(parents=True,mode=0o700)
    target=directory/'dump.rdb';shutil.copyfile(Path(snapshot_dir)/'workflow-redis.rdb',target);target.chmod(0o600)
    if sha(target)!=metadata['workflow-redis.rdb']['sha256']:raise RuntimeError('workflow_restore_redis_mismatch')
    # AOF takes precedence over RDB. Load the verified RDB with AOF disabled,
    # create a fresh complete AOF, then shut down before any coordinator starts.

    subprocess.run(command+['run','--rm','--no-deps','workflow-redis','sh','-c',REDIS_RESTORE_SCRIPT],env=env,check=True,timeout=90,stdout=subprocess.DEVNULL)
    return {'database_verified':True,'redis_verified':True,'active':False}
