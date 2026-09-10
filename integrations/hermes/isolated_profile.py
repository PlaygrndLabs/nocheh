"""Persistent native data paths; executable configuration is never writable by a turn."""
from pathlib import Path

DATA_DIRS=('native-state','memories','sessions','reviews')

def database_path(profile):
    profile=Path(profile)
    directory=profile/'native-state'
    target=directory/'state.db' if directory.exists() else profile/'state.db'
    if directory.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(profile.resolve()):
        raise ValueError('session_path_denied')
    return target

def prepare(profile):
    profile=Path(profile)
    if profile.is_symlink():raise ValueError('profile_path_denied')
    # Moving an open SQLite database is unsafe. Existing profiles are converted
    # offline by the owner service before isolated routing is activated.
    if (profile/'state.db').exists():raise ValueError('security_profile_conversion_required')
    for name in DATA_DIRS:
        path=profile/name
        if path.is_symlink():raise ValueError('profile_data_path_denied')
        path.mkdir(exist_ok=True,mode=0o700)
    if (profile/'config.yaml').is_symlink():raise ValueError('profile_configuration_path_denied')
