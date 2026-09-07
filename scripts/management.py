"""One bounded JSON operation per process; called by the local TypeScript API."""
import json
import os
import sys
from pathlib import Path
from .configuration import ROOT, load


def dispatch(body):
    state = Path(os.environ.get('NOCHEH_STATE_DIR', ROOT / 'data/local')).resolve()
    operation = body['operation']
    if operation.startswith('honcho.'):
        from .honcho import status, read
        if operation == 'honcho.status': return status()
        if operation == 'honcho.read': return read(body['args'])
    if operation == 'hermes.manage':
        from .archive import API
        return API().call('/v1/manage/hermes', body['request'])
    if operation == 'archive.read':
        from .archive import API
        from urllib.parse import urlsplit
        import re
        path = body['path']; parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or not (parsed.path in ('/v1/status', '/v1/search') or re.fullmatch(r'/v1/events/[a-f0-9]{64}', parsed.path)):
            raise ValueError('archive_route_denied')
        return API().call(path)
    if operation.startswith('settings.'):
        from .settings import view, save, apply
        if operation == 'settings.view': return view(state)
        if operation == 'settings.save': return save(state, body['changes'], body['revision'])
        if operation == 'settings.apply': return apply(state)
    if operation.startswith('import.'):
        from .import_job import inspect, run
        import re
        job = body['job']
        if not re.fullmatch(r'[a-f0-9-]{36}', job): raise ValueError('invalid_job')
        directory = state / 'admin/jobs' / job
        if operation == 'import.inspect': return inspect(directory)
        if operation == 'import.run':
            mapping = body.get('mapping', {})
            policy = load(state)
            allowed = set(filter(None, [policy['TELEGRAM_OWNER_ID'], *policy['TELEGRAM_GROUP_IDS'].split(',')]))
            if not isinstance(mapping, dict) or any(not isinstance(k, str) or v not in allowed for k, v in mapping.items()):
                raise ValueError('scope_mapping_denied')
            return run(directory, mapping, body.get('after', 0))
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
