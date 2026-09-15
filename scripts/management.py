"""One bounded JSON operation per process; called by the local TypeScript API."""
import json
import os
import sys
from pathlib import Path
from .configuration import ROOT, load


def dispatch(body):
    state = Path(os.environ.get('NOCHEH_STATE_DIR', ROOT / 'data/local')).resolve()
    operation = body['operation']
    if operation=='archive.connection':
        config=load(state)
        return {'port':int(config['NOCHEH_PORT']),'token':config['SERVICE_TOKEN']}
    if operation=='workflow.import.batch':
        from .workflow_jobs import import_batch
        return import_batch(state,body)
    if operation=='workflow.tools.tick':
        from .workflow_jobs import tool_tick
        return tool_tick(state,body)
    if operation=='workflow.api':
        from .archive import API
        import re
        path=body['path']
        read_path=path.split('?',1)[0]
        public=re.fullmatch(r'/v1/workflows(?:/(?:health|[a-f0-9]{64}))?',read_path) and 'body' not in body
        internal=re.fullmatch(r'/v1/workflows/(?:[a-f0-9]{64}/(?:retry|cancel)|imports/(?:confirm|cancel|[a-f0-9-]{36})|host/(?:claim|renew|finish|continue|heartbeat))',path)
        if not public and not internal:raise ValueError('workflow_route_denied')
        return API().call(path,body.get('body'))
    if operation == 'monitoring.status':
        from .monitoring import status
        return status(state)
    if operation == 'tools.manage':
        from .archive import API
        from urllib.error import HTTPError
        action=body.get('action','actions')
        if action not in ('actions','decide','telegram-decision','grant','revoke'):raise ValueError('tools_route_denied')
        try:return API().call('/v1/tools/'+action,None if action=='actions' else body['request'])
        except HTTPError as error:
            try:code=json.load(error).get('error')
            except Exception:code=None
            allowed={'action_changed','action_already_started_or_closed','invalid_permission_bounds','action_not_found','permission_not_found'}
            raise ValueError(code if code in allowed else 'tools_operation_unavailable') from None
    if operation == 'policy.manage':
        from .native import call
        from urllib.parse import urlencode
        request = body['request']
        query = urlencode({key:request[key] for key in ('profile', 'job') if request.get(key)})
        path = ('/api/nocheh/preferences' if request.get('profile') and not request.get('job') else '/api/nocheh/policy') + '?' + query
        return call(state, path, request if body.get('write') else None, 'PUT' if body.get('write') else 'GET')
    if operation == 'native.connection':
        from .configuration import native_admin_port
        return {'port': int(os.environ.get('NOCHEH_NATIVE_ADMIN_PORT') or native_admin_port(state)), 'token': load(state)['SERVICE_TOKEN']}
    if operation == 'memory.api':
        from .archive import API
        from urllib.parse import urlsplit
        path=body['path'];parsed=urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.path not in ('/v1/memory/honcho','/v1/memory/spaces','/v1/memory/shares','/v1/memory/shares/revoke','/v1/memory/reviews','/v1/memory/reviews/control','/v1/memory/recall','/v1/memory/preview'):
            raise ValueError('memory_route_denied')
        return API().call(path,body.get('body'))
    if operation == 'operations.list':
        from .admin_operations import backups
        return {'backups':backups(state)}
    if operation == 'operations.run':
        from .admin_operations import run
        return run(state,body['action'],body['job'],body.get('options'))
    if operation == 'archive.cache':
        import re, tempfile
        from .archive import API
        id=body['id']
        if not re.fullmatch(r'[a-f0-9]{64}',id):raise ValueError('invalid_artifact')
        data=API().call('/v1/artifacts/'+id+'/bytes',binary=True)
        root=state/'admin/downloads';root.mkdir(parents=True,exist_ok=True,mode=0o700)
        with tempfile.NamedTemporaryFile(dir=root,delete=False) as file:
            file.write(data);file.flush();os.fsync(file.fileno());temporary=Path(file.name)
        temporary.replace(root/id)
        return {'id':id}
    if operation == 'graph.read':
        from .graph import read
        return read(body['scope'],body.get('after',''),body.get('focus',''))
    if operation.startswith('honcho.'):
        from .honcho import status, read
        if operation == 'honcho.status': return status()
        if operation == 'honcho.read': return read(body['args'])
    if operation == 'hermes.manage':
        from .archive import API
        import urllib.error
        try: return API().call('/v1/manage/hermes', body['request'])
        except urllib.error.HTTPError as error:
            if error.code == 409: raise ValueError('configuration_conflict') from None
            raise
    if operation == 'archive.projections':
        from .archive import API
        from urllib.parse import urlsplit
        import re
        import urllib.error
        path=body['path'];parsed=urlsplit(path)
        if parsed.scheme or parsed.netloc or not (parsed.path=='/v1/data' or re.fullmatch(r'/v1/data/[a-f0-9]{64}/guarded(?:/history)?',parsed.path)):
            raise ValueError('archive_route_denied')
        if 'body' in body and not re.fullmatch(r'/v1/data/[a-f0-9]{64}/guarded',parsed.path): raise ValueError('archive_route_denied')
        try: return API().call(path,body.get('body'))
        except urllib.error.HTTPError as error:
            if error.code==409: raise ValueError('guard_revision_conflict') from None
            raise ValueError('guarded_data_unavailable') from None
    if operation == 'archive.read':
        from .archive import API
        from urllib.parse import urlsplit
        import re
        path = body['path']; parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or not (parsed.path in ('/v1/status', '/v1/runtime', '/v1/search', '/v1/scopes') or re.fullmatch(r'/v1/events/[a-f0-9]{64}', parsed.path)):
            raise ValueError('archive_route_denied')
        return API().call(path)
    if operation.startswith('settings.'):
        from .settings import view, save, apply
        if operation == 'settings.view': return view(state)
        if operation == 'settings.save': return save(state, body['changes'], body['revision'])
        if operation == 'settings.apply': return apply(state)
    if operation.startswith('import.'):
        from .import_job import inspect
        import re
        job = body['job']
        if not re.fullmatch(r'[a-f0-9-]{36}', job): raise ValueError('invalid_job')
        directory = state / 'admin/jobs' / job
        if operation == 'import.inspect': return inspect(directory)
    raise ValueError('unknown_operation')


def main():
    try:
        body = json.loads(sys.stdin.buffer.read(1024 * 1024))
        result = dispatch(body)
        print(json.dumps({'result': result}, ensure_ascii=False), flush=True)
    except Exception as error:
        # Never relay provider bodies, subprocess output, credentials or source text.
        code = str(error) if isinstance(error, ValueError) and str(error).replace('_', '').isalnum() else type(error).__name__
        print(json.dumps({'error': code}), flush=True)
        return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
