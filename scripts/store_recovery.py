"""Three-store recovery primitives. Call only after stopping installation writers.

Hold ``barrier`` through database, original-file, and native-store snapshots.
The barrier freezes database rows; it cannot stop an independent filesystem writer.
Restores require three absent target databases and leave runtime roles NOLOGIN.
"""
import hashlib
import json
import os
import re
import subprocess
from contextlib import contextmanager
from pathlib import Path

STORES=('archive','derived','control')
IDENTIFIER=re.compile(r'[a-z_][a-z0-9_]{0,62}')
HASH=re.compile(r'[a-f0-9]{64}')


def assert_no_state_writers(state,environment,command):
    """Catch orphan native/tool containers after their Compose launchers stop.

    Inspect mount metadata only. Never stop an unrelated container or expose its
    environment. Databases are covered by the barrier; quiesced workflow Redis
    remains up only to produce its own snapshot.
    """
    allowed=set(subprocess.check_output(command+['ps','-q','nocheh-postgres','honcho-postgres','inngest-redis'],
        env=environment,text=True).split())
    identifiers=subprocess.check_output(['docker','ps','-q','--no-trunc'],env=environment,text=True).split()
    roots=[Path(state).resolve(),Path(environment.get('NOCHEH_HONCHO_STATE_DIR') or Path(state)/'honcho').resolve()]
    for identifier in identifiers:
        if identifier in allowed:continue
        mounts=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .Mounts}}',identifier],
            env=environment,text=True))
        for mount in mounts:
            if not mount.get('RW') or mount.get('Type')!='bind':continue
            source=Path(mount['Source']).resolve()
            if any(source.is_relative_to(root) or root.is_relative_to(source) for root in roots):
                raise RuntimeError('installation_state_writer_still_running')


class StoreRecovery:
    def __init__(self,command,environment,service='nocheh-postgres'):
        if not IDENTIFIER.fullmatch(service.replace('-','_')):raise ValueError('invalid_database_service')
        self.command=list(command);self.environment=environment;self.service=service;self.holders=[];self.coordinator=None

    def prefix(self,store=None):
        if store is not None and store not in STORES:raise ValueError('invalid_store')
        return self.command+['exec','-T',self.service,'psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1',
                             '-U','nocheh','-d','nocheh_'+store if store else 'nocheh']

    def query(self,store,sql):
        return subprocess.check_output(self.prefix(store)+['-c',sql],env=self.environment,text=True,stderr=subprocess.DEVNULL)

    def names(self,store,kind='tables'):
        sql=("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1" if kind=='tables' else
             "SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY 1")
        names=self.query(store,sql).split()
        if len(names)>500 or any(not IDENTIFIER.fullmatch(name) for name in names):raise ValueError('store_relations_invalid')
        return names

    @contextmanager
    def maintenance(self):
        """Serialize coordinators before inspecting or stopping any writers."""
        if self.coordinator is not None:raise RuntimeError('store_maintenance_already_held')
        process=subprocess.Popen(self.prefix(),env=self.environment,stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        self.coordinator=process
        try:
            process.stdin.write("SELECT CASE WHEN pg_try_advisory_lock(803361) THEN 'acquired' ELSE 'busy' END;\n")
            process.stdin.flush()
            if process.stdout.readline().strip()!='acquired':raise RuntimeError('store_maintenance_busy')
            yield self
        finally:
            try:
                if process.poll() is None:process.communicate('',timeout=10)
            except (OSError,subprocess.TimeoutExpired):process.kill();process.wait()
            finally:
                if process.stdin:process.stdin.close()
                if process.stdout:process.stdout.close()
                self.coordinator=None

    def assert_maintenance(self):
        if self.coordinator is None or self.coordinator.poll() is not None:raise RuntimeError('store_maintenance_lost')

    @contextmanager
    def barrier(self):
        if self.holders:raise ValueError('store_barrier_already_held')
        try:
            for store in STORES:
                names=self.names(store)
                if not names:raise ValueError('store_schema_missing')
                process=subprocess.Popen(self.prefix(store),env=self.environment,stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
                self.holders.append(process)
                relations=','.join('public."'+name+'"' for name in names)
                process.stdin.write("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s';\n"
                    f'LOCK TABLE {relations} IN SHARE MODE;\n'+"SELECT 'nocheh-store-barrier';\n")
                process.stdin.flush()
                if process.stdout.readline().strip()!='nocheh-store-barrier':raise RuntimeError('store_barrier_unavailable')
            yield self
        finally:
            for process in reversed(self.holders):
                try:
                    if process.poll() is None:process.communicate('ROLLBACK;\n',timeout=10)
                except (OSError,subprocess.TimeoutExpired):
                    process.kill();process.wait()
                finally:
                    if process.stdin:process.stdin.close()
                    if process.stdout:process.stdout.close()
            self.holders=[]

    def assert_barrier(self):
        if self.coordinator is not None:self.assert_maintenance()
        if len(self.holders)!=3 or any(p.poll() is not None for p in self.holders):raise RuntimeError('store_barrier_required')

    def fingerprints(self,store):
        tables={}
        for name in self.names(store):
            sql=f'''SET TIME ZONE 'UTC'; COPY (SELECT row_to_json(t) FROM public."{name}" t
                ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT'''
            process=subprocess.Popen(self.prefix(store)+['-c',sql],env=self.environment,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
            digest=hashlib.sha256()
            for chunk in iter(lambda:process.stdout.read(1024*1024),b''):digest.update(chunk)
            process.stdout.close()
            if process.wait():raise RuntimeError('store_fingerprint_failed')
            tables[name]=digest.hexdigest()
        sequences={name:json.loads(self.query(store,f'''SELECT json_build_object('last_value',last_value::text,'is_called',is_called)
            FROM public."{name}"''')) for name in self.names(store,'sequences')}
        return {'tables':tables,'sequences':sequences}

    def snapshot(self,directory,sha):
        self.assert_barrier();result={'version':1,'databases':{}}
        for store in STORES:
            fingerprints=self.fingerprints(store);path=Path(directory)/(store+'.dump')
            with path.open('xb') as output:
                path.chmod(0o600)
                subprocess.run(self.command+['exec','-T',self.service,'pg_dump','-U','nocheh','-d','nocheh_'+store,
                    '-Fc','--no-password','--no-owner','--no-acl'],env=self.environment,stdout=output,stderr=subprocess.DEVNULL,check=True)
                output.flush();os.fsync(output.fileno())
            self.assert_barrier()
            if self.fingerprints(store)!=fingerprints:raise RuntimeError('store_snapshot_changed')
            result['databases'][store]={'sha256':sha(path),'size':path.stat().st_size,**fingerprints}
        return result

    def restore_inactive(self,directory,metadata,sha):
        validate(directory,metadata,sha)
        existing=self.query(None,"SELECT datname FROM pg_database WHERE datname IN ('nocheh_archive','nocheh_derived','nocheh_control')").split()
        if existing:raise ValueError('store_restore_requires_absent_databases')
        # Fail before creating anything if a role belongs to another/partial installation.
        roles=[f'nocheh_{s}{suffix}' for s in STORES for suffix in ('','_owner')]
        if self.query(None,'SELECT rolname FROM pg_roles WHERE rolname IN ('+','.join("'"+r+"'" for r in roles)+')').strip():
            raise ValueError('store_restore_requires_absent_roles')
        for store in STORES:
            database='nocheh_'+store;owner=database+'_owner'
            self.query(None,f'CREATE ROLE {owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; '
                f'CREATE ROLE {database} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;')
            self.query(None,f'CREATE DATABASE {database} OWNER {owner}')
            self.query(None,f'REVOKE ALL ON DATABASE {database} FROM PUBLIC')
            with (Path(directory)/(store+'.dump')).open('rb') as source:
                subprocess.run(self.command+['exec','-T',self.service,'pg_restore','-U','nocheh','-d',database,
                    '--role='+owner,'--no-password','--no-owner','--no-acl','--exit-on-error'],env=self.environment,stdin=source,
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            expected=metadata['databases'][store]
            if self.fingerprints(store)!={'tables':expected['tables'],'sequences':expected['sequences']}:
                raise RuntimeError('store_restore_fingerprint_mismatch')
            self.query(store,'REVOKE ALL ON SCHEMA public FROM PUBLIC')
        # Preserve historical operation identities, but invalidate old runtime capabilities.
        self.query('control',"UPDATE guard_state SET epoch=epoch+1; UPDATE memory_engine_connection SET attached=false,verified=false;")
        return {'verified_databases':list(STORES),'runtime_login_enabled':False,'active':False}


def validate(directory,metadata,sha):
    if not isinstance(metadata,dict) or metadata.get('version')!=1 or not isinstance(metadata.get('databases'),dict) or set(metadata['databases'])!=set(STORES):
        raise ValueError('store_snapshot_version_invalid')
    for store in STORES:
        record=metadata['databases'][store];path=Path(directory)/(store+'.dump')
        if not isinstance(record,dict) or path.is_symlink() or not path.is_file() or path.stat().st_size!=record.get('size') or sha(path)!=record.get('sha256'):
            raise ValueError('store_snapshot_checksum_mismatch')
        tables=record.get('tables');sequences=record.get('sequences')
        if not isinstance(tables,dict) or not tables or len(tables)>500 or any(not IDENTIFIER.fullmatch(k) or not isinstance(v,str) or not HASH.fullmatch(v) for k,v in tables.items()):
            raise ValueError('store_snapshot_tables_invalid')
        if not isinstance(sequences,dict) or len(sequences)>500:raise ValueError('store_snapshot_sequences_invalid')
        for key,value in sequences.items():
            if not IDENTIFIER.fullmatch(key) or not isinstance(value,dict) or set(value)!={'last_value','is_called'} or not isinstance(value['last_value'],str) or not re.fullmatch(r'-?\d{1,19}',value['last_value']) or type(value['is_called']) is not bool:
                raise ValueError('store_snapshot_sequences_invalid')
