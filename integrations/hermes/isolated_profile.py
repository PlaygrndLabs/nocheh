"""Persistent native data paths; executable configuration is never writable by a turn."""
from pathlib import Path

DATA_DIRS=('native-state','memories','sessions','reviews')
DATA_FILES=('.memory.lock',)

def database_path(profile):
    profile=Path(profile)
    if profile.is_symlink():raise ValueError('profile_path_denied')
    directory=profile/'native-state'
    legacy=profile/'state.db';current=directory/'state.db'
    if legacy.exists() and current.exists():raise ValueError('ambiguous_native_database_layout')
    target=current if current.exists() or directory.exists() and not legacy.exists() else legacy
    if directory.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(profile.resolve()):
        raise ValueError('session_path_denied')
    return target

def install_database_paths():
    """Native APIs that open the default DB must see the same migrated history."""
    import hermes_state
    original=hermes_state._default_db_path
    if getattr(original,'_nocheh_data_path',False):return lambda:None
    def current():
        path=Path(original())
        return database_path(path.parent) if path.name=='state.db' and path.parent.name!='native-state' else path
    current._nocheh_data_path=True
    hermes_state._default_db_path=current
    # The pinned process registry opens its delegation ledger during import,
    # using sqlite3 directly. Keep that ledger in the same durable database.
    from tools import async_delegation
    from gateway import delivery_ledger
    originals=[(hermes_state,'_default_db_path',original)]
    for module in (async_delegation,delivery_ledger):
        prior=module._db_path;originals.append((module,'_db_path',prior))
        def mapped(fn=prior):
            path=Path(fn())
            return database_path(path.parent) if path.name=='state.db' and path.parent.name!='native-state' else path
        module._db_path=mapped
    def restore():
        for module,name,prior in reversed(originals):setattr(module,name,prior)
    return restore

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
    for name in DATA_FILES:
        path=profile/name
        if path.is_symlink():raise ValueError('profile_data_path_denied')
        path.touch(exist_ok=True,mode=0o600)
    if (profile/'config.yaml').is_symlink():raise ValueError('profile_configuration_path_denied')
