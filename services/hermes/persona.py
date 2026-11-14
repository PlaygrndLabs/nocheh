"""Owner-set role and skills, kept in Hermes' own profile layout.

A chat's canonical profile holds its role as Hermes `SOUL.md` and its skills as
Hermes `skills/<name>/SKILL.md`. `projects/<id>/` holds the same files for every
chat in a project. Each audience has its own default: `nocheh-default/` for the
owner's private chat and `nocheh-default-groups/` for every group and topic. Any
turn that is not the owner's own private chat reads the groups default, so the
owner's private default never loads anywhere else. Before each turn the effective
files are copied into the turn's profile, where the turn reads them and cannot
change them. Topics use their group's.
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

from .isolated_profile import database_path
from .scopes import Scopes

# One default folder per audience. A later member-chat step adds its own key; until then every turn that is not the
# owner's private chat falls back to the groups default (ADR-0244).
DEFAULTS = {'owner': 'nocheh-default', 'group': 'nocheh-default-groups'}
ROLE_LIMIT = 20000
SKILL_LIMIT = 30
DESCRIPTION_LIMIT = 1024
BODY_LIMIT = 20000
NAME = re.compile(r'[a-z][a-z0-9-]{0,63}')
PROJECT = re.compile(r'[a-f0-9]{64}')
FRONTMATTER = re.compile(r'^---\n(.*?)\n---\n?(.*)$', re.S)


def default_path(root, audience):
    if audience not in DEFAULTS: raise ValueError('invalid_audience')
    return Path(root) / DEFAULTS[audience]


def audience(scope):
    """The owner's private chat and its topics read the owner's default; every other turn reads the groups default."""
    return 'owner' if scope.owner is True else 'group'


def chat_path(root, chat):
    return Path(root) / 'profiles' / Scopes.profile(chat)


def project_path(root, project):
    if not isinstance(project, str) or not PROJECT.fullmatch(project): raise ValueError('invalid_project')
    return Path(root) / 'projects' / project


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
    """Replace SOUL.md and skills/ in `path` with exactly the given role and skills, then have Hermes
    rebuild the stored prompt of each of the profile's sessions once, on its next turn."""
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
    _refresh_prompts(path)


def _refresh_prompts(path):
    """Hermes reuses a continuing session's stored system prompt, so a new role or skills would never reach it.
    Its own refresh request, made after the files are in place and under the caller's lock, rebuilds each of the
    profile's sessions once and keeps their history and tools. A folder with no sessions, such as the default's
    or a project's, is left as it is."""
    database = database_path(path)
    if not database.exists(): return
    from hermes_state import SessionDB
    sessions = SessionDB(database)
    try: sessions.request_prompt_refresh()
    finally: sessions.close()


def save(path, role, skills, expected):
    path = Path(path)
    role, skills = validate(role, skills)
    path.mkdir(parents=True, exist_ok=True, mode=0o700); _safe(path)
    with (path / '.persona.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if expected != revision(read(path)): raise ValueError('configuration_conflict')
        _install(path, role, skills)
    return view(path)


def effective(root, chat, project='', audience='group'):
    """The chat's own role, else its project's, else its audience's default role. Skills add up from that
    default to the project's to the chat's, and a later one wins by name. Without an audience a turn reads
    the groups default, so a forgotten argument never loads the owner's private default. Without a chat, as
    in a private answer, no chat's own role or skills load: the project's, else the default (ADR-0249)."""
    empty = {'role': '', 'skills': []}
    layers = [read(default_path(root, audience)), read(project_path(root, project)) if project else empty,
              read(chat_path(root, chat)) if chat else empty]
    skills = {}
    for layer in layers: skills.update({skill['name']: skill for skill in layer['skills']})
    return {'role': next((layer['role'] for layer in reversed(layers) if layer['role']), ''),
            'skills': [skills[name] for name in sorted(skills)]}


def materialize(root, profile, chat, project='', audience='group'):
    """Give a turn profile its effective role and skills; the owner's own source folder is never rewritten."""
    profile = Path(profile)
    if chat and profile.resolve() == chat_path(root, chat).resolve():
        # A turn that runs in the canonical profile already reads the chat's own files.
        (profile / 'skills').mkdir(exist_ok=True, mode=0o700)
        if not (profile / 'SOUL.md').exists(): _write(profile / 'SOUL.md', '')
        return
    value = effective(root, chat, project, audience)
    with (profile / '.persona.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (profile / 'SOUL.md').is_file() and (profile / 'skills').is_dir() and read(profile) == value: return
        try: _install(profile, value['role'], value['skills'])
        except BaseException:
            # These are derived copies: without SOUL.md the next turn installs them again and asks Hermes again.
            (profile / 'SOUL.md').unlink(missing_ok=True); raise

