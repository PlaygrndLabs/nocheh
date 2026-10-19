"""Owner-set role and skills, kept in Hermes' own profile layout.

A chat's canonical profile holds its role as Hermes `SOUL.md` and its skills as
Hermes `skills/<name>/SKILL.md`. `nocheh-default/` holds the same files for every
chat. Before each turn the effective files are copied into the turn's profile,
where the turn reads them and cannot change them. Topics use their group's.
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import yaml

from .scopes import Scopes

DEFAULT = 'nocheh-default'
ROLE_LIMIT = 20000
SKILL_LIMIT = 30
DESCRIPTION_LIMIT = 1024
BODY_LIMIT = 20000
NAME = re.compile(r'[a-z][a-z0-9-]{0,63}')
FRONTMATTER = re.compile(r'^---\n(.*?)\n---\n?(.*)$', re.S)


def default_path(root):
    return Path(root) / DEFAULT


def chat_path(root, chat):
    return Path(root) / 'profiles' / Scopes.profile(chat)


def _safe(path):
    if path.is_symlink(): raise ValueError('profile_path_denied')
    return path


def _text(path, limit):
    _safe(path)
    if not path.is_file(): return ''
    with path.open('rb') as source: raw = source.read(limit * 4 + 1)
    return raw.decode('utf-8', errors='replace')


def read(path):
    """Role and skills stored in one profile-shaped folder; missing files read as empty."""
    path = Path(path)
    if not path.exists(): return {'role': '', 'skills': []}
    _safe(path)
    role = _text(path / 'SOUL.md', ROLE_LIMIT).strip()
    skills = []
    folder = _safe(path / 'skills')
    if folder.is_dir():
        for item in sorted(folder.iterdir()):
            if item.is_symlink() or not item.is_dir() or not NAME.fullmatch(item.name): continue
            match = FRONTMATTER.match(_text(item / 'SKILL.md', BODY_LIMIT + DESCRIPTION_LIMIT).replace('\r\n', '\n'))
            if not match: continue
            try: meta = yaml.safe_load(match.group(1)) or {}
            except yaml.YAMLError: continue
            if not isinstance(meta, dict): continue
            skills.append({'name': item.name, 'description': str(meta.get('description') or '').strip(),
                           'body': match.group(2).strip()})
    return {'role': role, 'skills': skills}


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def view(path):
    value = read(path)
    return {**value, 'revision': revision(value)}


def validate(role, skills):
    if not isinstance(role, str) or len(role) > ROLE_LIMIT: raise ValueError('invalid_persona')
    if not isinstance(skills, list) or len(skills) > SKILL_LIMIT: raise ValueError('invalid_persona')
    names, result = set(), []
    for skill in skills:
        if not isinstance(skill, dict) or set(skill) - {'name', 'description', 'body'}: raise ValueError('invalid_persona')
        name, description, body = skill.get('name'), skill.get('description'), skill.get('body')
        if (not isinstance(name, str) or not NAME.fullmatch(name) or name in names or
                not isinstance(description, str) or not 0 < len(description.strip()) <= DESCRIPTION_LIMIT or
                not isinstance(body, str) or not 0 < len(body.strip()) <= BODY_LIMIT):
            raise ValueError('invalid_persona')
        names.add(name)
        result.append({'name': name, 'description': description.strip(), 'body': body.strip()})
    return role.strip(), result


def _write(path, text):
    descriptor, name = tempfile.mkstemp(prefix='.persona-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
            file.write(text); file.flush(); os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def _skill_text(skill):
    meta = yaml.safe_dump({'name': skill['name'], 'description': skill['description']},
                          allow_unicode=True, sort_keys=False, width=100000).strip()
    return '---\n' + meta + '\n---\n\n' + skill['body'] + '\n'


def _install(path, role, skills):
    """Replace SOUL.md and skills/ in `path` with exactly the given role and skills."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700); _safe(path)
    soul = _safe(path / 'SOUL.md')
    _write(soul, role + '\n' if role else '')
    folder = _safe(path / 'skills')
    staged = Path(tempfile.mkdtemp(prefix='.skills-', dir=path))
    try:
        for skill in skills:
            item = staged / skill['name']; item.mkdir(mode=0o700)
            (item / 'SKILL.md').write_text(_skill_text(skill), encoding='utf-8')
        retired = None
        if folder.exists():
            retired = path / ('.skills-retired-' + os.urandom(6).hex())
            folder.rename(retired)
        staged.rename(folder)
        if retired is not None: shutil.rmtree(retired)
    finally:
        if staged.exists(): shutil.rmtree(staged)


def save(path, role, skills, expected):
    path = Path(path)
    role, skills = validate(role, skills)
    path.mkdir(parents=True, exist_ok=True, mode=0o700); _safe(path)
    with (path / '.persona.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if expected != revision(read(path)): raise ValueError('configuration_conflict')
        _install(path, role, skills)
    return view(path)


def effective(root, chat):
    """The chat's own role, else the default role; default skills plus the chat's, the chat's winning by name."""
    own, shared = read(chat_path(root, chat)), read(default_path(root))
    skills = {skill['name']: skill for skill in shared['skills']}
    skills.update({skill['name']: skill for skill in own['skills']})
    return {'role': own['role'] or shared['role'], 'skills': [skills[name] for name in sorted(skills)]}


def materialize(root, profile, chat):
    """Give a turn profile its effective role and skills; the owner's own source folder is never rewritten."""
    profile = Path(profile)
    if profile.resolve() == chat_path(root, chat).resolve():
        # A turn that runs in the canonical profile already reads the chat's own files.
        (profile / 'skills').mkdir(exist_ok=True, mode=0o700)
        if not (profile / 'SOUL.md').exists(): _write(profile / 'SOUL.md', '')
        return
    value = effective(root, chat)
    with (profile / '.persona.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (profile / 'SOUL.md').is_file() and (profile / 'skills').is_dir() and read(profile) == value: return
        _install(profile, value['role'], value['skills'])


def refresh_prompt(profile, database, session_id):
    """Rebuild a continuing session's system prompt after its role or skills changed.

    Hermes reuses a session's stored system prompt (and tool order) on later
    turns, so a role or skill saved after the session began would otherwise
    never reach it. The revision that last built the prompt is kept beside the
    session database, which stays writable in isolated turns.
    """
    current = revision(read(profile))
    marker = Path(database.db_path).parent / 'persona-prompt.json'
    try:
        previous = json.loads(marker.read_text())
    except (OSError, ValueError):
        previous = {}
    if previous == {'session': session_id, 'revision': current}:
        return False
    changed = database.get_session(session_id) is not None
    if changed:
        database.update_system_prompt(session_id, None)
        database.update_session_tool_names(session_id, None)
    _write(marker, json.dumps({'session': session_id, 'revision': current}))
    return changed
