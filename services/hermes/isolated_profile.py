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

def native_path(path):
    """A profile's ``state.db`` as the durable database it names."""
    path=Path(path)
    return database_path(path.parent) if path.name=='state.db' and path.parent.name!='native-state' else path


def install_database_paths():
    """Native APIs that open a profile DB must see the same migrated history."""
    from .native_store import install_store_paths
    if getattr(install_database_paths,'_installed',False):return lambda:None
    # Every store Hermes opens (sessions, the delegation and delivery ledgers) is the profile's durable one.
    unmap=install_store_paths()
    originals=[]
    # Nocheh owns each profile's SOUL.md (the owner-set role, empty when unset)
    # and writes config.yaml itself. Hermes would otherwise seed its own
    # identity as a role and copy config.yaml into backups/ whenever a profile
    # is merely read, for example by the dashboard's inspection routes.
    from hermes_cli import config as hermes_config, config_backups
    seed,backup=hermes_config._ensure_default_soul_md,config_backups.backup_config
    def no_seed(home):return None
    def backup_without_good(config_path,reason,**kwargs):
        return None if reason=='good' else backup(config_path,reason,**kwargs)
    originals+=[(hermes_config,'_ensure_default_soul_md',seed),(config_backups,'backup_config',backup)]
    hermes_config._ensure_default_soul_md=no_seed;config_backups.backup_config=backup_without_good
    install_database_paths._installed=True
    def restore():
        for module,name,prior in reversed(originals):setattr(module,name,prior)
        unmap();install_database_paths._installed=False
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
    # The role and skills are mounted read-only; an unset role or no skills is an empty file or folder.
    if (profile/'SOUL.md').is_symlink() or (profile/'skills').is_symlink():raise ValueError('profile_configuration_path_denied')
    (profile/'skills').mkdir(exist_ok=True,mode=0o700)
    (profile/'SOUL.md').touch(exist_ok=True,mode=0o600)
