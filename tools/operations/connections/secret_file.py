"""Owner sign-in files in the installation's admin folder (ADR-0175).

Each connection keeps one JSON file, `<state>/admin/connections/<name>.json`, readable only by the management
and executor services. The folder is 0700, one flock (`<name>.lock`) guards each file, a symlinked file is refused,
and a write lands whole: fsynced at 0600, then renamed into place.
"""
import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path


def path(state, name):
    return Path(state) / 'admin/connections' / (name + '.json')


@contextmanager
def locked(state, name):
    folder = path(state, name).parent
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder / (name + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read(state, name):
    file = path(state, name)
    if file.is_symlink(): raise ValueError(name + '_connection_path_denied')
    return json.loads(file.read_text()) if file.exists() else {}


def write(state, name, value):
    file = path(state, name); temporary = file.with_suffix('.tmp')
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        json.dump(value, handle); handle.flush(); os.fsync(handle.fileno())
    temporary.replace(file)
