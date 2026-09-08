"""Enumerated dashboard operations; filesystem destinations are generated locally."""
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path
from .configuration import ROOT


def identifier(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',value): raise ValueError('invalid_operation_id')
    return value


def backups(state):
    root=state/'admin/backups';result=[]
    for path in sorted(root.glob('*'),reverse=True):
        try:
            identifier(path.name)
            if path.is_symlink():continue
            manifest=json.loads((path/'manifest.json').read_text())
            result.append({'id':path.name,'created_at':manifest['created_at'],'files':len(manifest['files'])})
        except (ValueError,KeyError,OSError):continue
    return result[:100]


def run(state,action,job,options=None):
    identifier(job);options=options or {};environment={**os.environ,'NOCHEH_STATE_DIR':str(state)}
    if action in ('export','portable-export'):
        from .archive import API,export_archive
        root=state/'admin/exports'/job;root.mkdir(parents=True,mode=0o700)
        if action=='portable-export':
            from .portable import export_all
            manifest=export_all(state,root/'archive')
        else:manifest=export_archive(API(),root/'archive')
        temporary=root/'export.part'
        with zipfile.ZipFile(temporary,'x',compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((root/'archive').rglob('*')):
                if path.is_file():archive.write(path,path.relative_to(root/'archive'))
        temporary.chmod(0o600);temporary.rename(root/'export.zip')
        if action=='portable-export':return {'status':'exported','format':manifest['format'],'complete':manifest['complete'],
            'events':manifest['archive']['events'],'files':manifest['archive']['files'],'export_files':len(manifest['files']),
            'native_profiles':len(manifest['native_profiles']),'job':job}
        return {'status':'exported',**manifest,'job':job}
    args=[str(ROOT/'scripts/nocheh')]
    if action=='diagnose':args+=['diagnose']
    elif action=='backup':args+=['backup','--output',str(state/'admin/backups'/job)]
    elif action=='restart':
        from .operations import compose,environment as compose_env
        # Compose honors service stop grace periods and waits for readiness.
        subprocess.run(compose(state)+['restart','hermes','worker','guard','archive'],env=compose_env(state),check=True,capture_output=True)
        subprocess.run(compose(state)+['up','-d','--no-build','--wait','--wait-timeout','180'],env=compose_env(state),check=True,capture_output=True)
        return {'status':'restarted'}
    elif action=='restore':
        backup=identifier(options.get('backup'));port=options.get('port')
        if type(port) is not int or not 1024<=port<=65535:raise ValueError('invalid_restore_port')
        import socket
        with socket.socket() as sock:
            try:sock.bind(('127.0.0.1',port))
            except OSError:raise ValueError('restore_port_in_use') from None
        snapshot=state/'admin/backups'/backup
        if snapshot.is_symlink():raise ValueError('invalid_backup_path')
        args+=['restore',str(snapshot),'--state',str(state/'admin/restores'/job),'--project','nocheh-restore-'+job,'--port',str(port)]
    else:raise ValueError('operation_denied')
    process=subprocess.run(args,env=environment,cwd=ROOT,capture_output=True,text=True)
    if process.returncode:raise ValueError('operation_failed')
    return json.loads(process.stdout)
