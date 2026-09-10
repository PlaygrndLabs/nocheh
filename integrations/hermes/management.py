"""Owner-only native profile inspection; every request selects an allowed chat."""
import hashlib
import re
from pathlib import Path
from .scopes import Scopes
from .profile_config import configure_profile, inspect_profile


def profile_path(root, chat, policy, selected=None):
    if selected and chat in [policy.owner, *policy.groups] and selected == Scopes.profile(chat):
        selected = None  # Canonical profiles can be inspected before their first turn.
    if selected:
        from .native_memory import registered_profiles
        import json
        paths={p.name:p for p in registered_profiles(root)}
        path=paths.get(selected)
        if path is None:raise ValueError('profile_scope_denied')
        marker=path/'space.json'
        if marker.is_symlink():raise ValueError('profile_path_denied')
        metadata=json.loads(marker.read_text()) if marker.exists() else {}
        if metadata.get('space')!=chat and path.name!=Scopes.profile(chat) and path.name!=chat:raise ValueError('profile_scope_denied')
        return path
    allowed = [policy.owner, *policy.groups]
    if not isinstance(chat, str) or chat not in allowed: raise ValueError('profile_scope_denied')
    root = Path(root).resolve()
    path = root / 'profiles' / Scopes.profile(chat)
    if path.is_symlink() or not path.resolve().is_relative_to(root): raise ValueError('profile_path_denied')
    return path


def dispatch(root, model, policy, body):
    action = body.get('action')
    if action == 'profiles':
        profiles=[{'scope': chat, 'profile': Scopes.profile(chat),
                 'owner': chat == policy.owner, 'exists': profile_path(root, chat, policy).exists()}
                for chat in [policy.owner, *policy.groups] if chat]
        from .native_memory import registered_profiles
        import json
        historical={p['profile']:p for p in profiles}
        for path in registered_profiles(root):
            marker=path/'space.json'
            if marker.is_symlink():raise ValueError('profile_path_denied')
            metadata=json.loads(marker.read_text()) if marker.exists() else {}
            historical[path.name]={'scope':metadata.get('space',historical.get(path.name,{}).get('scope',path.name)),
                                   'profile':path.name,'owner':metadata.get('owner',False),'revision':metadata.get('revision',0),'exists':True}
        return {'profiles':profiles,'history_profiles':list(historical.values())}
    path = profile_path(root, body.get('scope'), policy,body.get('profile') if action=='memory' else None)
    if action == 'preferences':
        result = configure_profile(path, model, body['changes'], body.get('revision')) if 'changes' in body else inspect_profile(path, model)
        return {'scope': body['scope'], **result}
    if action != 'memory': raise ValueError('unknown_management_action')
    memories = []
    for name in ('MEMORY.md', 'USER.md'):
        file = path / 'memories' / name
        if file.is_symlink() or not file.resolve().is_relative_to(path.resolve()): raise ValueError('memory_path_denied')
        raw = b''
        if file.exists():
            with file.open('rb') as source: raw = source.read(256 * 1024 + 1)
        truncated = len(raw) > 256 * 1024; text = raw[:256 * 1024].decode('utf-8', errors='replace')
        memories.append({'name': name, 'text': text, 'exists': file.exists(), 'truncated': truncated,
                         'sha256': hashlib.sha256(raw).hexdigest() if not truncated else None,
                         'citations': sorted(set(re.findall(r'nocheh:event:([a-f0-9]{64})', text)))})
    result = {'scope': body['scope'], 'profile': path.name, 'memories': memories,
              'sessions': [], 'messages': [], 'next_offset': None,
              'provenance': 'Native notes are model-maintained; only explicit citations identify source evidence.'}
    from .isolated_profile import database_path
    database = database_path(path)
    if database.is_symlink(): raise ValueError('session_path_denied')
    if not database.exists(): return result
    offset = body.get('offset', 0)
    if type(offset) is not int or not 0 <= offset <= 100000: raise ValueError('invalid_offset')
    from hermes_state import SessionDB
    db = SessionDB(database, read_only=True)
    try:
        session = body.get('session')
        if session:
            if not isinstance(session, str) or len(session) > 256 or not db.get_session(session):
                raise ValueError('session_not_in_profile')
            messages = db.get_messages(session, limit=51, offset=offset)
            result['messages'] = [{'id': m.get('id'), 'role': m.get('role'),
                'content': str(m.get('content') or '')[:20000], 'timestamp': m.get('timestamp'),
                'truncated': len(str(m.get('content') or '')) > 20000} for m in messages[:50]]
            if len(messages) > 50: result['next_offset'] = offset + 50
        else:
            sessions = db.search_sessions(limit=51, offset=offset)
            result['sessions'] = [{k: s.get(k) for k in ('id', 'title', 'source', 'started_at', 'ended_at', 'model')}
                                  for s in sessions[:50]]
            if len(sessions) > 50: result['next_offset'] = offset + 50
    finally: db.close()
    return result
