"""Offline native SQLite layout conversion. Run only while Hermes is stopped."""
import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
from contextlib import ExitStack
from pathlib import Path
from integrations.hermes.isolated_profile import DATA_DIRS

def convert(profile):
    profile=Path(profile)
    if profile.is_symlink() or not profile.is_dir():raise ValueError('profile_path_denied')
    source=profile/'state.db';directory=profile/'native-state';target=directory/'state.db'
    if any((profile/name).is_symlink() for name in (*DATA_DIRS,'state.db','config.yaml')):raise ValueError('profile_path_denied')
    with ExitStack() as stack:
        for name in ('.turn.lock','.memory.lock'):
            file=stack.enter_context((profile/name).open('a'))
            try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise ValueError('profile_busy') from None
        if source.exists() and target.exists():raise ValueError('ambiguous_native_database_layout')
        result={'profile':profile.name,'moved':False,'preserved':True}
        if source.exists():
            database=sqlite3.connect(source,timeout=1)
            try:
                if database.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('native_database_check_failed')
                checkpoint=database.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
                if checkpoint[0]!=0:raise ValueError('native_database_in_use')
            finally:database.close()
            before=hashlib.sha256(source.read_bytes()).hexdigest()
            directory.mkdir(exist_ok=True,mode=0o700)
            os.replace(source,target)
            if hashlib.sha256(target.read_bytes()).hexdigest()!=before:raise RuntimeError('native_database_identity_changed')
            result.update(moved=True,sha256=before)
            # Checkpointed sidecars are retained as diagnostic artifacts, not deleted.
            for suffix in ('-wal','-shm'):
                old=Path(str(source)+suffix)
                if old.exists():os.replace(old,directory/('pre-conversion'+suffix))
        for name in DATA_DIRS:(profile/name).mkdir(exist_ok=True,mode=0o700)
        for parent in (directory,profile):
            descriptor=os.open(parent,os.O_RDONLY)
            try:os.fsync(descriptor)
            finally:os.close(descriptor)
        return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('root',type=Path);parser.add_argument('--hermes-stopped',action='store_true',required=True)
    args=parser.parse_args()
    profiles=args.root/'profiles'
    if profiles.is_symlink():raise ValueError('profile_path_denied')
    print(json.dumps({'profiles':[convert(path) for path in sorted(profiles.iterdir()) if path.is_dir() and not path.is_symlink()]}))

if __name__=='__main__':main()
