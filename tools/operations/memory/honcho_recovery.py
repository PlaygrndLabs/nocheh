"""Quiesced memory snapshots and verification in an inactive, separate installation."""
import hashlib
import re
import shutil
import subprocess
from pathlib import Path

DATABASE='honcho_experiment'


def fingerprints(command,env,tables=None):
    prefix=command+['exec','-T','honcho-postgres','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','experiment','-d',DATABASE]
    if tables is None:
        tables=subprocess.check_output(prefix+['-c',"SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%' ORDER BY 1"],env=env,text=True).split()
    result={}
    for table in tables:
        if not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*',table):raise ValueError('honcho_snapshot_table_invalid')
        schema,name=table.split('.')
        query=f'COPY (SELECT row_to_json(t) FROM "{schema}"."{name}" t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT'
        process=subprocess.Popen(prefix+['-c',query],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        digest=hashlib.sha256()
        while chunk:=process.stdout.read(1024*1024):digest.update(chunk)
        if process.wait():raise RuntimeError('honcho_fingerprint_failed')
        result[table]=digest.hexdigest()
    return result


def snapshot(command,env,directory,sha):
    tables=fingerprints(command,env)
    path=Path(directory)/'honcho.dump'
    with path.open('xb') as output:
        path.chmod(0o600)
        subprocess.run(command+['exec','-T','honcho-postgres','pg_dump','-U','experiment','-d',DATABASE,'-Fc','--no-owner','--no-acl'],env=env,stdout=output,stderr=subprocess.DEVNULL,check=True)
        output.flush();__import__('os').fsync(output.fileno())
    return {'version':1,'sha256':sha(path),'size':path.stat().st_size,'tables':tables,'cache':'rebuild'}


def validate(directory,metadata,sha):
    path=Path(directory)/'honcho.dump'
    if not isinstance(metadata,dict) or metadata.get('version')!=1:raise ValueError('honcho_snapshot_version_invalid')
    if path.is_symlink() or not path.is_file() or path.stat().st_size!=metadata.get('size') or sha(path)!=metadata.get('sha256'):raise ValueError('honcho_snapshot_checksum_mismatch')
    tables=metadata.get('tables')
    if not isinstance(tables,dict) or any(not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*',t) for t in tables):raise ValueError('honcho_snapshot_table_invalid')


def restore(command,env,directory,state,metadata,sha):
    validate(directory,metadata,sha)
    volumes=[env['NOCHEH_HONCHO_DATABASE_VOLUME'],env['NOCHEH_HONCHO_REDIS_VOLUME']]
    for volume in volumes:
        if subprocess.run(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise ValueError('honcho_restore_volume_exists')
    for volume in volumes:subprocess.run(['docker','volume','create',volume],check=True,stdout=subprocess.DEVNULL)
    memory=Path(state)/'honcho'
    if not (memory/'database_password').is_file():raise ValueError('honcho_restore_credentials_missing')
    ledger=Path(state)/'memory-ledger/budget.sqlite'
    if ledger.exists():
        (memory/'ledger').mkdir(mode=0o700)
        shutil.copyfile(ledger,memory/'ledger/budget.sqlite');(memory/'ledger/budget.sqlite').chmod(0o600)
    try:
        subprocess.run(command+['--profile','honcho','up','-d','--no-build','--wait','honcho-postgres'],env=env,check=True)
        with (Path(directory)/'honcho.dump').open('rb') as source:
            subprocess.run(command+['exec','-T','honcho-postgres','pg_restore','-U','experiment','-d',DATABASE,'--no-owner','--no-acl','--exit-on-error'],env=env,stdin=source,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
        if fingerprints(command,env,metadata['tables'])!=metadata['tables']:raise RuntimeError('honcho_restore_fingerprint_mismatch')
    finally:
        subprocess.run(command+['--profile','honcho','stop','honcho-postgres'],env=env,check=True)
