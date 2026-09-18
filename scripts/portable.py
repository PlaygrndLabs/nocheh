"""Portable archive and native memory, without operational credentials or activation."""
import argparse
import fcntl
import json
import sqlite3
import shutil
import tempfile
from datetime import datetime,timezone
from pathlib import Path
from .archive import API,export_archive
from .operations import sha


def export_database(database,destination,locked):
    def copy_with_sqlite(uri):
        source=sqlite3.connect(uri,uri=True);target=sqlite3.connect(destination)
        try:source.backup(target);target.commit()
        finally:target.close();source.close()
    wal=database.with_name(database.name+'-wal')
    for suffix in ('-wal','-shm','-journal'):
        if database.with_name(database.name+suffix).is_symlink():raise ValueError('native_export_path_denied')
    if wal.exists():copy_with_sqlite(database.as_uri()+'?mode=ro')
    else:
        # Some SQLite builds cannot open a closed WAL-mode database read-only
        # without creating WAL/SHM files. Snapshot under the native writer lock.
        if not locked:raise ValueError('native_snapshot_lock_required')
        before=database.stat()
        with tempfile.TemporaryDirectory(prefix='.snapshot-',dir=destination.parent) as folder:
            snapshot=Path(folder)/'state.db';shutil.copyfile(database,snapshot);snapshot.chmod(0o600)
            after=database.stat()
            if wal.exists() or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):
                raise ValueError('native_snapshot_retry_required')
            # The existing native writer lock covers the copy. Immutable applies
            # only to this private, verified copy, never to a live database.
            copy_with_sqlite(snapshot.as_uri()+'?mode=ro&immutable=1')


def export_native(root,directory):
    from integrations.hermes.native_memory import registered_profiles
    from integrations.hermes.isolated_profile import database_path
    profiles=[];directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    for profile in registered_profiles(root):
        destination=directory/profile.name;destination.mkdir(mode=0o700)
        item={'profile':profile.name,'origin':'native_generated','notes':[],'sessions':False}
        # Do not create or repair native state during export. A read lock shares
        # the native writer's existing lock; atomic note writes remain whole.
        lock_path=profile/'.memory.lock'
        if lock_path.is_symlink():raise ValueError('native_export_path_denied')
        lock=lock_path.open('rb') if lock_path.exists() else None
        try:
            if lock:fcntl.flock(lock,fcntl.LOCK_SH)
            for name in ('memories/MEMORY.md','memories/USER.md','space.json','nocheh-owner-profile.json'):
                source=profile/name
                if source.is_symlink() or not source.resolve().is_relative_to(profile.resolve()):raise ValueError('native_export_path_denied')
                if not source.is_file():continue
                target=destination/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                shutil.copyfile(source,target);target.chmod(0o600)
                if name.startswith('memories/'):item['notes'].append(name)
            database=database_path(profile)
            if database.is_symlink():raise ValueError('native_export_path_denied')
            if database.exists():
                # SQLite's backup API captures committed WAL state too.
                export_database(database,destination/'state.db',lock is not None)
                (destination/'state.db').chmod(0o600);item['sessions']=True
        finally:
            if lock:lock.close()
        profiles.append(item)
    return profiles


def export_all(state,directory,api=None):
    directory=Path(directory).resolve();directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    manifest={'format':'nocheh-portable-v1','complete':False,'started_at':datetime.now(timezone.utc).isoformat(),
        'consistency':'Archive and each native profile are read separately; use a quiesced backup for a single recovery point.',
        'credentials_included':False,'automatic_activation':False}
    metadata=directory/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n');metadata.chmod(0o600)
    manifest['archive']=export_archive(api or API(),directory/'archive')
    manifest['native_profiles']=export_native(Path(state)/'hermes',directory/'native')
    manifest['files']={}
    for path in sorted(directory.rglob('*')):
        if path==metadata or not path.is_file():continue
        path.chmod(0o600)
        manifest['files'][str(path.relative_to(directory))]={'size':path.stat().st_size,'sha256':sha(path)}
    manifest.update(complete=True,finished_at=datetime.now(timezone.utc).isoformat())
    metadata.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--sources-only',action='store_true',help='Export only original observations and files, without derivatives or native memory.')
    options=parser.parse_args(args)
    if options.sources_only:
        result=export_archive(API(),options.output,source_only=True)
        print(json.dumps({'status':'exported','path':str(options.output.resolve()),**result}));return 0
    result=export_all(state,options.output)
    print(json.dumps({'status':'exported','path':str(options.output.resolve()),'events':result['archive']['events'],
        'native_profiles':len(result['native_profiles']),'complete':result['complete']}));return 0
