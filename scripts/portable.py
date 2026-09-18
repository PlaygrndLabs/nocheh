"""Portable archive and native memory, without operational credentials or activation."""
import argparse
import fcntl
import json
import os
import re
import sqlite3
import shutil
import tempfile
from datetime import datetime,timezone
from pathlib import Path
from .archive import API,export_archive,import_archive,validate_archive
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


def export_all(state,directory,api=None,*,honcho_export=None):
    api=api or API();separated=getattr(api,'storage_layout','legacy')=='original-only-v1'
    directory=Path(directory).resolve();directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    manifest={'format':'nocheh-portable-v2' if separated else 'nocheh-portable-v1','complete':False,'started_at':datetime.now(timezone.utc).isoformat(),
        'consistency':'Sources, derivative histories and each native store are read separately; use a quiesced backup for a single recovery point.',
        'credentials_included':False,'automatic_activation':False}
    metadata=directory/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n');metadata.chmod(0o600)
    manifest['archive']=export_archive(api,directory/'archive',source_only=separated)
    if separated:
        from .derivative_transfer import export_derivatives
        from .honcho_portable import export_honcho
        manifest['derivatives']=export_derivatives(api,directory/'derivatives')
        manifest['honcho']=(honcho_export or export_honcho)(state,directory/'honcho')
    manifest['native_profiles']=export_native(Path(state)/'hermes',directory/'native')
    manifest['files']={}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():raise ValueError('portable_path_denied')
        if path==metadata or not path.is_file():continue
        path.chmod(0o600)
        manifest['files'][str(path.relative_to(directory))]={'size':path.stat().st_size,'sha256':sha(path)}
    manifest.update(complete=True,finished_at=datetime.now(timezone.utc).isoformat())
    if separated:_validate_package(directory,manifest)
    _atomic_bytes(metadata,(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode(),replace=True)
    return manifest


def _relative(value):
    if not isinstance(value,str) or not value or '\\' in value or '\0' in value or any(part in ('','.','..') for part in value.split('/')) or Path(value).is_absolute():raise ValueError('portable_path_denied')
    return value


def validate_package(directory):
    directory=Path(directory)
    if directory.is_symlink():raise ValueError('portable_path_denied')
    metadata=directory/'manifest.json'
    if metadata.is_symlink():raise ValueError('portable_path_denied')
    manifest=json.loads(metadata.read_text())
    return _validate_package(directory,manifest)


def _validate_package(directory,manifest):
    metadata=directory/'manifest.json'
    if manifest.get('format') not in ('nocheh-portable-v1','nocheh-portable-v2') or manifest.get('complete') is not True or manifest.get('automatic_activation') is not False or manifest.get('credentials_included') is not False:
        raise ValueError('portable_manifest_invalid')
    legacy=manifest['format']=='nocheh-portable-v1'
    files=manifest.get('files')
    if not isinstance(files,dict) or len(files)>100000:raise ValueError('portable_files_invalid')
    actual=set()
    for path in directory.rglob('*'):
        if path.is_symlink():raise ValueError('portable_path_denied')
        if path.is_dir():continue
        if not path.is_file():raise ValueError('portable_path_denied')
        if path!=metadata:actual.add(path.relative_to(directory).as_posix())
    if actual!=set(files):raise ValueError('portable_file_inventory_mismatch')
    for name,item in files.items():
        path=directory/_relative(name)
        if not isinstance(item,dict) or type(item.get('size')) is not int or path.stat().st_size!=item['size'] or sha(path)!=item.get('sha256'):raise ValueError('portable_integrity_failed')
        if name.split('/')[0] not in (('archive','native') if legacy else ('archive','derivatives','native','honcho')):raise ValueError('portable_domain_invalid')
    archive=validate_archive(directory/'archive')
    if archive.get('format')!=('nocheh-archive-v1' if legacy else 'nocheh-sources-v1') or archive!=manifest.get('archive'):raise ValueError('portable_archive_manifest_mismatch')
    if not legacy:
        from .derivative_transfer import validate_derivatives,validate_references
        if validate_derivatives(directory/'derivatives')!=manifest.get('derivatives'):raise ValueError('portable_derivatives_manifest_mismatch')
        validate_references(directory/'derivatives',directory/'archive')
    profiles=manifest.get('native_profiles')
    if not isinstance(profiles,list) or len(profiles)>10000:raise ValueError('portable_profiles_invalid')
    seen=set();allowed=set()
    for item in profiles:
        if not isinstance(item,dict) or not re.fullmatch('[a-zA-Z0-9_-]{1,128}',str(item.get('profile',''))) or item['profile'] in seen or item.get('origin')!='native_generated' or type(item.get('sessions')) is not bool:
            raise ValueError('portable_profiles_invalid')
        name=item['profile'];seen.add(name)
        notes=item.get('notes')
        if not isinstance(notes,list) or len(set(notes))!=len(notes) or any(note not in ('memories/MEMORY.md','memories/USER.md') for note in notes):raise ValueError('portable_notes_invalid')
        allowed.update('native/'+name+'/'+note for note in notes)
        for marker in ('space.json','nocheh-owner-profile.json'):
            if 'native/'+name+'/'+marker in files:allowed.add('native/'+name+'/'+marker)
        if item['sessions']:
            path=directory/'native'/name/'state.db';allowed.add('native/'+name+'/state.db')
            database=sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)
            try:
                database.execute('PRAGMA trusted_schema=OFF')
                if database.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('portable_native_integrity_failed')
            finally:database.close()
    if {name for name in files if name.startswith('native/')}!=allowed:raise ValueError('portable_native_inventory_mismatch')
    honcho=manifest.get('honcho',{'included':False} if legacy else None)
    if not isinstance(honcho,dict) or type(honcho.get('included')) is not bool:raise ValueError('portable_honcho_invalid')
    if honcho['included']:
        from .honcho_portable import validate_honcho,TABLES
        expected=validate_honcho(directory/'honcho')
        if {k:v for k,v in honcho.items() if k!='included'}!=expected:raise ValueError('portable_honcho_manifest_mismatch')
        if {name for name in files if name.startswith('honcho/')}!={'honcho/manifest.json',*('honcho/'+table+'.ndjson' for table in TABLES)}:raise ValueError('portable_honcho_inventory_mismatch')
    elif any(name.startswith('honcho/') for name in files):raise ValueError('portable_honcho_inventory_mismatch')
    return manifest


def _atomic_bytes(path,content,replace=False):
    with tempfile.NamedTemporaryFile(prefix='.portable-',dir=path.parent,delete=False) as output:
        temporary=Path(output.name)
        try:
            output.write(content);output.flush();os.fsync(output.fileno())
            if replace:temporary.replace(path)
            else:os.link(temporary,path)
        finally:temporary.unlink(missing_ok=True)
    descriptor=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def import_all(directory,native_output,api=None,*,restore_guarded=False):
    """Import data idempotently; native files stay in an isolated inactive package.

    This path never overwrites Hermes homes, attaches Honcho, executes dump SQL,
    copies credentials, or resumes a native queue. Native adoption is a separate
    operation subject to the destination's guard and audience policy.
    """
    directory=Path(directory).resolve();manifest=validate_package(directory)
    api=api or API()
    if getattr(api,'storage_layout','legacy')!='original-only-v1':raise ValueError('portable_requires_original_only_layout')
    target=Path(native_output)
    if target.is_symlink():raise ValueError('portable_path_denied')
    target=target.resolve()
    if target==directory or target.is_relative_to(directory) or directory.is_relative_to(target):raise ValueError('portable_destination_overlaps_source')
    bundle=sha(directory/'manifest.json');receipt=target/'import.json'
    if target.exists():
        if receipt.is_symlink() or not receipt.is_file():raise ValueError('portable_destination_exists')
        prior=json.loads(receipt.read_text())
        if prior.get('bundle')!=bundle or prior.get('automatic_activation') is not False or (target/'.restore-inactive').is_symlink() or not (target/'.restore-inactive').is_file():raise ValueError('portable_destination_conflict')
    else:
        target.mkdir(parents=True,mode=0o700);(target/'.restore-inactive').write_text('Portable native history: no runtime or memory activation.\n')
        (target/'.restore-inactive').chmod(0o600)
    def save(complete,**extra):
        value={'bundle':bundle,'complete':complete,'automatic_activation':False,**extra}
        _atomic_bytes(receipt,(json.dumps(value,indent=2)+'\n').encode(),replace=True);return value
    save(False)
    package=target/'package.json'
    if package.is_symlink() or package.exists() and sha(package)!=bundle:raise ValueError('portable_destination_conflict')
    if not package.exists():
        _atomic_bytes(package,(directory/'manifest.json').read_bytes())
    # Retain native data before remote writes. An interrupted import can resume
    # only against the same bundle, and never replaces a conflicting local file.
    for name,item in manifest['files'].items():
        if not name.startswith(('native/','honcho/')):continue
        destination=target/name
        if any(parent.is_symlink() for parent in destination.parents if parent!=target.parent):raise ValueError('portable_path_denied')
        destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        if destination.is_symlink():raise ValueError('portable_path_denied')
        if destination.exists():
            if not destination.is_file() or sha(destination)!=item['sha256']:raise ValueError('portable_destination_conflict')
        else:
            with tempfile.NamedTemporaryFile(prefix='.portable-',dir=destination.parent,delete=False) as output:
                temporary=Path(output.name)
                try:
                    with (directory/name).open('rb') as source:shutil.copyfileobj(source,output)
                    output.flush();os.fsync(output.fileno())
                    # Refuse a destination created after the earlier check.
                    os.link(temporary,destination)
                finally:temporary.unlink(missing_ok=True)
            descriptor=os.open(destination.parent,os.O_RDONLY)
            try:os.fsync(descriptor)
            finally:os.close(descriptor)
    from .derivative_transfer import import_derivatives
    legacy=manifest['format']=='nocheh-portable-v1'
    sources=import_archive(api,directory/'archive',restore_guarded=restore_guarded if legacy else False)
    derivatives={'included_with_legacy_records':True,'automatic_activation':False} if legacy else import_derivatives(api,directory/'derivatives')
    result=save(True,sources=sources,derivatives=derivatives,native_profiles=len(manifest['native_profiles']),honcho_included=manifest.get('honcho',{}).get('included',False))
    return {**result,'native_path':str(target),'telegram_replies':0}


def import_main(state,args):
    if '--honcho-memory' in args:
        parser=argparse.ArgumentParser(description='Restore portable Honcho rows into an empty initialized native database in an inactive installation.')
        parser.add_argument('--honcho-memory',type=Path,required=True);parser.add_argument('--inactive-state',type=Path,required=True)
        options=parser.parse_args(args)
        from .honcho_portable import restore_honcho
        print(json.dumps(restore_honcho(options.inactive_state,options.honcho_memory)));return 0
    parser=argparse.ArgumentParser(description='Import a portable package; stage native history without activation.')
    parser.add_argument('--portable',type=Path,required=True);parser.add_argument('--native-output',type=Path,required=True)
    parser.add_argument('--restore-guarded',action='store_true',help='Materialize trusted legacy guarded history as inactive revisions; exact input verification still applies.')
    options=parser.parse_args(args)
    # A portable target is never an active installation directory.
    native=options.native_output.resolve();installation=Path(state).resolve()
    if native==installation or native.is_relative_to(installation) or installation.is_relative_to(native):raise ValueError('portable_native_target_must_be_separate')
    print(json.dumps(import_all(options.portable,options.native_output,restore_guarded=options.restore_guarded)));return 0


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
