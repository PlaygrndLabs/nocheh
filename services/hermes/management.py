"""Owner-only native profile inspection; every request selects an allowed chat."""
import hashlib
import re
from pathlib import Path
from .scopes import Scopes
from .profile_config import configure_profile, inspect_profile


def allowed_chats(policy):
    """The owner's private chat and every served group, by their Nocheh chat ids, as the app's served list has them
    (ADR-0252)."""
    served = policy.current()
    return [chat for chat in [served.owner_chat, *served.groups()] if chat]


def profile_path(root, chat, policy, selected=None):
    if selected and chat in allowed_chats(policy) and selected == Scopes.profile(chat):
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
    if not isinstance(chat, str) or chat not in allowed_chats(policy): raise ValueError('profile_scope_denied')
    root = Path(root).resolve()
    path = root / 'profiles' / Scopes.profile(chat)
    if path.is_symlink() or not path.resolve().is_relative_to(root): raise ValueError('profile_path_denied')
    return path


def answer_receipt(path):
    """Where a private answer was asked, as its first line names it, and when it ran, from the receipt its turn left in
    its profile (ADR-0249); nothing when there is none or it cannot be read."""
    import json
    receipt=path/'answer.json'
    try:
        if receipt.is_symlink() or not receipt.is_file():return {}
        value=json.loads(receipt.read_text())
    except (OSError,ValueError):return {}
    group,at=value.get('group') if isinstance(value,dict) else None,value.get('at') if isinstance(value,dict) else None
    return {**({'answer_group':group} if isinstance(group,str) and 0<len(group)<=300 else {}),
            **({'answer_at':at} if isinstance(at,str) and len(at)<=40 else {})}


def dispatch(root, model, policy, body):
    action = body.get('action')
    if action == 'profiles':
        owner = policy.current().owner_chat
        profiles=[{'scope': chat, 'profile': Scopes.profile(chat),
                 'owner': chat == owner, 'exists': profile_path(root, chat, policy).exists()}
                for chat in allowed_chats(policy)]
        from .native_memory import registered_profiles
        import json
        historical={p['profile']:p for p in profiles}
        meta,at={},{}
        for path in registered_profiles(root):
            marker=path/'space.json'
            if marker.is_symlink():raise ValueError('profile_path_denied')
            metadata=json.loads(marker.read_text()) if marker.exists() else {}
            meta[path.name]=metadata;at[path.name]=marker.stat().st_mtime if marker.exists() else 0
            historical[path.name]={'scope':metadata.get('space',historical.get(path.name,{}).get('scope',path.name)),
                                   'profile':path.name,'owner':metadata.get('owner',False),'revision':metadata.get('revision',0),
                                   'guard_epoch':metadata.get('guard_epoch',0),'exists':True,
                                   # A private answer's own profile, in the owner's private chat but never the owner's (ADR-0249),
                                   # named by where it was asked and when, as its receipt keeps them.
                                   **({'private_answer':True,**answer_receipt(path)} if metadata.get('answer') else {}),
                                   # A member's own private chat (step 4): never the owner's, whatever its chat is.
                                   **({'member':True} if metadata.get('member') else {}),
                                   # The owner's ask about a member (step 4b): never the owner's own chat either; dated
                                   # by when it ran, as its receipt keeps it.
                                   **({'member_read':True,**{key:value for key,value in answer_receipt(path).items() if key=='answer_at'}}
                                      if metadata.get('member_read') else {})}
        listed=list(historical.values())
        # A chat keeps one profile per setup (installation, policy revision and guard epoch), so after a reinstall the
        # same chat is listed more than once. The newest one that exists is the one its turns use now; the dashboard opens
        # on it and names the others as earlier ones. A reinstall starts its guard epochs again at 1, so the installation
        # whose profiles were used last comes first (each turn rewrites its space.json), then the epoch and revision.
        # Only a chat's own profile can be its current notes: never a private answer, an ask about a member, or a named
        # profile beside it.
        used={}
        for name,metadata in meta.items():
            generation=metadata.get('generation') or '';used[generation]=max(used.get(generation,0),at[name])
        def own(entry):
            metadata=meta.get(entry['profile'],{})
            return (not entry.get('private_answer') and not entry.get('member_read') and metadata.get('purpose','assistant')!='filter'
                    and (metadata.get('logical_profile') or '') in ('',Scopes.profile(entry['scope'])))
        newest={}
        for entry in listed:
            if not entry.get('exists') or not own(entry):continue
            rank=(used.get(meta.get(entry['profile'],{}).get('generation') or '',0),entry.get('guard_epoch',0),entry.get('revision',0))
            if entry['scope'] not in newest or rank>newest[entry['scope']][0]:newest[entry['scope']]=(rank,entry['profile'])
        for entry in listed:
            if own(entry) and entry['scope'] in newest:entry['latest']=newest[entry['scope']][1]==entry['profile']
        return {'profiles':profiles,'history_profiles':listed}
    if action == 'prompts':
        from .prompts import DEFAULTS, LIMIT
        return {'defaults': DEFAULTS, 'limit': LIMIT}
    if action == 'persona':
        from . import persona
        scope = body.get('scope')
        # `default` is the owner's private chat's default, `default:groups` the one every group and topic reads.
        path = (persona.default_path(root, 'owner') if scope == 'default' else persona.default_path(root, 'group') if scope == 'default:groups' else
                persona.project_path(root, scope.removeprefix('project:')) if isinstance(scope, str) and scope.startswith('project:') else
                profile_path(root, scope, policy))
        if 'role' in body or 'skills' in body:
            return {'scope': scope, **persona.save(path, body.get('role', ''), body.get('skills', []), body.get('revision'))}
        return {'scope': scope, **persona.view(path)}
    path = profile_path(root, body.get('scope'), policy,body.get('profile') if action=='memory' else None)
    if action == 'preferences':
        served = policy.current()
        result = (configure_profile(path, model, body['changes'], body.get('revision'), served=served) if 'changes' in body
                  else inspect_profile(path, model, served))
        return {'scope': body['scope'], **result}
    if action != 'memory': raise ValueError('unknown_management_action')
    memories = []
    # Each note on its own, with what this parent recorded about who wrote it, for storage to put in the owner's words
    # (ADR-0257). A file Hermes could not read either has no notes listed, and the page shows it whole.
    from . import note_sources
    found = note_sources.entries(path)
    records = note_sources.load(path) if found else {}
    for target, name in note_sources.TARGETS:
        file = path / 'memories' / name
        if file.is_symlink() or not file.resolve().is_relative_to(path.resolve()): raise ValueError('memory_path_denied')
        raw = b''
        if file.exists():
            with file.open('rb') as source: raw = source.read(256 * 1024 + 1)
        truncated = len(raw) > 256 * 1024; text = raw[:256 * 1024].decode('utf-8', errors='replace')
        memories.append({'name': name, 'text': text, 'exists': file.exists(), 'truncated': truncated,
                         'sha256': hashlib.sha256(raw).hexdigest() if not truncated else None,
                         'citations': sorted(set(re.findall(r'nocheh:event:([a-f0-9]{64})', text))),
                         **({'entries': [{'target': target, 'text': entry, **note_sources.note(records, target, entry)}
                                         for entry in found[target]]} if found is not None else {})})
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
