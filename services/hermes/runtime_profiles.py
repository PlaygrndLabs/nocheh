"""Control-owned profile identities; native paths are never authorization."""
import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from .scopes import Scope, Scopes

NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}')


class ProfileCatalog:
    def __init__(self, root, policy, token, request=None):
        self.root, self.policy, self.token = Path(root), policy, token
        self.request = request or self.http

    def http(self, route, body=None):
        request = Request(os.environ.get('ARCHIVE_URL', 'http://nocheh-app:8780') + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=10) as response:
                limit = 20 * 1024 * 1024 if route == '/v1/browser/undelivered' else 1024 * 1024
                data = response.read(limit + 1)
                if len(data) > limit: raise RuntimeError('profile_catalog_unavailable')
                return json.loads(data)
        except HTTPError as error:
            # Do not expose a server body (or transport credentials) through the
            # native dashboard. Only known profile conflicts are user-facing.
            try: code = json.loads(error.read(4096)).get('error')
            except Exception: code = None
            if code in {'profile_not_found', 'profile_scope_denied', 'invalid_profile_name',
                        'profile_name_conflict', 'profile_revision_conflict', 'profile_retired',
                        'owner_command_conflict', 'profile_limit'}:
                raise ValueError(code) from None
            raise RuntimeError('profile_catalog_unavailable') from None
        except (OSError, ValueError):
            raise RuntimeError('profile_catalog_unavailable') from None

    def path(self, name):
        if not isinstance(name, str) or not NAME.fullmatch(name): raise ValueError('profile_path_denied')
        parent = self.root / 'profiles'; path = parent / name
        if parent.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(parent.resolve()):
            raise ValueError('profile_path_denied')
        return path

    def validate(self, entry):
        try:
            chat, space, owner = entry['scope'], entry['space'], entry['owner']
            if (type(owner) is not bool or owner != (chat == self.policy.owner) or
                chat != self.policy.owner and chat not in self.policy.groups or
                not isinstance(space, str) or space != chat and
                (owner or not re.fullmatch(re.escape(chat) + r'/topic/[1-9]\d*', space))):
                raise ValueError()
            logical, preference = entry['logical_profile'], entry['preference_profile']
            default = Scopes.profile(space)
            if logical != default and (not owner or not re.fullmatch(r'profile-[a-f0-9]{48}', logical)):
                raise ValueError()
            if preference != logical or type(entry['policy_revision']) is not int or entry['policy_revision'] < 1:
                raise ValueError()
            bound = Scopes.apply_revision(Scope(chat, self.policy.owner, owner, default, space, entry['policy_revision']),
                {'revision': entry['policy_revision'], 'guard_epoch': entry['guard_epoch'],
                 'generation': entry['generation'], 'logical_profile': logical})
            if bound.profile != entry['native_profile']: raise ValueError()
            self.path(preference); self.path(bound.profile)
            return bound
        except (KeyError, TypeError, ValueError):
            raise ValueError('profile_scope_denied') from None

    def resolve(self, name=None):
        selected = name or ''
        if selected and not NAME.fullmatch(selected): raise ValueError('profile_scope_denied')
        body = {'profile': selected}
        if selected:
            marker = self.path(selected) / 'space.json'
            # A topic marker is only a lookup hint. The control service must
            # resolve it against current policy and the current native identity.
            if marker.is_file() and not marker.is_symlink() and marker.stat().st_size <= 4096:
                space = json.loads(marker.read_text()).get('space')
                if isinstance(space, str) and '/topic/' in space: body['space'] = space
        entry = self.request('/v1/runtime/profiles/resolve', body)
        self.validate(entry)
        return entry

    def list(self):
        entries = self.request('/v1/runtime/profiles')['profiles']
        if not isinstance(entries, list) or len(entries) > 1000: raise ValueError('profile_limit')
        for entry in entries: self.validate(entry)
        return entries

    def save(self, body):
        return self.request('/v1/runtime/profiles', body)
