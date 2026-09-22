"""Portable native Honcho memory rows; no credentials, work queue, or activation."""
import json
import os
import re
import subprocess
from contextlib import contextmanager
from pathlib import Path
from .archive import file_digest

TABLES=('workspaces','peers','sessions','messages','message_embeddings','collections','documents','session_peers')
IDENTIFIER=re.compile(r'[a-z_][a-z0-9_]{0,62}')
SNAPSHOT=re.compile(r'[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+')


class NativeMemoryExport:
    def __init__(self,command,environment,service='honcho-postgres',database='honcho_experiment',user='experiment'):
        if any(not IDENTIFIER.fullmatch(value.replace('-','_')) for value in (service,database,user)):raise ValueError('native_export_target_invalid')
        self.prefix=list(command)+['exec','-T',service,'psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-U',user,'-d',database]
        self.environment=environment

    @contextmanager
    def snapshot(self):
        process=subprocess.Popen(self.prefix,env=self.environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        try:
            process.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SELECT pg_export_snapshot();\n");process.stdin.flush()
            snapshot=process.stdout.readline().strip()
            if not SNAPSHOT.fullmatch(snapshot):raise RuntimeError('native_memory_snapshot_unavailable')
            yield snapshot,process
            if process.poll() is not None:raise RuntimeError('native_memory_snapshot_lost')
        finally:
            try:
                if process.poll() is None:process.communicate('ROLLBACK;\n',timeout=10)
            except (OSError,subprocess.TimeoutExpired):process.kill();process.wait()
            finally:
                if process.stdin:process.stdin.close()
                if process.stdout:process.stdout.close()

    def query(self,snapshot,sql,output=None):
        if not SNAPSHOT.fullmatch(snapshot):raise ValueError('native_memory_snapshot_invalid')
        command="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '"+snapshot+"'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'; "+sql+'; COMMIT;'
        return subprocess.run(self.prefix+['-c',command],env=self.environment,stdout=output if output else subprocess.PIPE,
            stderr=subprocess.DEVNULL,text=output is None,check=True).stdout

    def export(self,directory):
        directory=Path(directory);directory.mkdir(parents=True,exist_ok=False,mode=0o700)
        pin=json.loads((Path(__file__).resolve().parents[1]/'integrations/honcho/upstreams.lock.json').read_text())['honcho']['revision']
        result={'format':'nocheh-honcho-memory-v1','producer_revision':pin,'automatic_activation':False,'tables':{},'complete':False}
        metadata=directory/'manifest.json';metadata.write_text(json.dumps(result,indent=2)+'\n');metadata.chmod(0o600)
        with self.snapshot() as (snapshot,process):
            schemas=self.query(snapshot,"SELECT schemaname FROM pg_tables WHERE tablename='workspaces' AND schemaname NOT IN ('pg_catalog','information_schema')").split()
            if len(schemas)!=1 or not IDENTIFIER.fullmatch(schemas[0]):raise ValueError('native_memory_schema_unavailable')
            schema=schemas[0];result['schema']=schema
            for table in TABLES:
                # Data-only JSON preserves native facts and embeddings while remaining
                # inspectable without executing a bundle's SQL/schema or queued work.
                relation='"'+schema+'"."'+table+'"'
                columns=self.query(snapshot,"SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid='"+relation+"'::regclass AND a.attnum>0 AND NOT a.attisdropped").strip()
                columns=json.loads(columns)
                if not isinstance(columns,list) or not columns:raise ValueError('native_memory_columns_unavailable')
                path=directory/(table+'.ndjson')
                with path.open('xb') as output:
                    path.chmod(0o600)
                    # psql prints one JSON object per row; JSON escapes embedded
                    # newlines. No text-mode COPY escaping corrupts string values.
                    self.query(snapshot,'SELECT row_to_json(t) FROM '+relation+' t ORDER BY row_to_json(t)::text COLLATE "C"',output)
                    output.flush();os.fsync(output.fileno())
                if process.poll() is not None:raise RuntimeError('native_memory_snapshot_lost')
                with path.open('rb') as source:count=sum(1 for _ in source)
                result['tables'][table]={'columns':columns,'rows':count,'sha256':file_digest(path),'size':path.stat().st_size}
        result['complete']=True;metadata.write_text(json.dumps(result,indent=2)+'\n')
        return result


    def restore_inactive(self,directory):
        """Restore rows only into empty, initialized native tables in one transaction.

        The installation coordinator must first enforce inactive ownership. This
        primitive never initializes schema, starts a native service, or accepts SQL
        from the package; column types must match the installed pinned schema.
        """
        directory=Path(directory);manifest=validate_honcho(directory)
        pin=json.loads((Path(__file__).resolve().parents[1]/'integrations/honcho/upstreams.lock.json').read_text())['honcho']['revision']
        if manifest['producer_revision']!=pin:raise ValueError('native_memory_schema_version_mismatch')
        schema=manifest['schema'];relations={table:'"'+schema+'"."'+table+'"' for table in TABLES}
        process=subprocess.Popen(self.prefix,env=self.environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        try:
            def write(sql):process.stdin.write(sql+';\n')
            write("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'")
            write('LOCK TABLE '+','.join(relations.values())+' IN EXCLUSIVE MODE')
            # Schema checks precede materialization and share its transaction.
            for table,relation in relations.items():
                expected=json.dumps(manifest['tables'][table]['columns'],separators=(',',':')).encode().hex()
                write("DO $check$ BEGIN IF (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid='"+relation+"'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM convert_from(decode('"+expected+"','hex'),'UTF8')::jsonb THEN RAISE EXCEPTION 'native_memory_columns_mismatch'; END IF; END $check$")
            for table in ('queue','active_queue_sessions','webhook_endpoints'):
                relation='"'+schema+'"."'+table+'"'
                # Operational tables are not portable. Existing work/attachments
                # make the destination unsuitable even when memory tables are empty.
                write("DO $check$ BEGIN IF to_regclass('"+relation+"') IS NOT NULL THEN EXECUTE 'LOCK TABLE "+relation+" IN EXCLUSIVE MODE'; IF EXISTS(SELECT 1 FROM "+relation+") THEN RAISE EXCEPTION 'native_memory_target_has_work'; END IF; END IF; END $check$")
            for table,relation in relations.items():
                write('CREATE TEMP TABLE nocheh_import_'+table+' ON COMMIT DROP AS SELECT * FROM '+relation+' WITH NO DATA')
                with (directory/(table+'.ndjson')).open('rb') as source:
                    for line in source:
                        encoded=line.strip().hex()
                        write('INSERT INTO pg_temp.nocheh_import_'+table+' SELECT * FROM json_populate_record(NULL::'+relation+",convert_from(decode('"+encoded+"','hex'),'UTF8')::json)")
            populated=' OR '.join('EXISTS(SELECT 1 FROM '+relation+')' for relation in relations.values())
            same=[]
            for table,relation in relations.items():
                left='SELECT row_to_json(t)::jsonb FROM '+relation+' t';right='SELECT row_to_json(t)::jsonb FROM pg_temp.nocheh_import_'+table+' t'
                same.append('NOT EXISTS(('+left+' EXCEPT ALL '+right+') UNION ALL ('+right+' EXCEPT ALL '+left+'))')
            write("DO $replay$ BEGIN IF ("+populated+") AND NOT ("+' AND '.join(same)+") THEN RAISE EXCEPTION 'native_memory_target_conflict'; END IF; END $replay$")
            for table,relation in relations.items():
                write('INSERT INTO '+relation+' OVERRIDING SYSTEM VALUE SELECT * FROM pg_temp.nocheh_import_'+table+' WHERE NOT EXISTS(SELECT 1 FROM '+relation+')')
                # Advance existing native identity sequences using the installed
                # schema, without trusting sequence names supplied by an export.
                for column in manifest['tables'][table]['columns']:
                    name=column['name']
                    if not IDENTIFIER.fullmatch(name):raise ValueError('native_memory_column_invalid')
                    write("DO $sequence$ DECLARE seq text; value bigint; populated boolean; BEGIN seq:=pg_get_serial_sequence('"+relation+"','"+name+"'); IF seq IS NOT NULL THEN SELECT max(\""+name+"\"),count(*)>0 INTO value,populated FROM "+relation+"; PERFORM setval(seq,coalesce(value,1),populated); END IF; END $sequence$")
            write("COMMIT; SELECT 'nocheh-native-imported'")
            process.stdin.close();result=process.stdout.read();code=process.wait()
            if code or result.strip()!='nocheh-native-imported':raise RuntimeError('native_memory_restore_failed')
        except (BrokenPipeError,OSError):raise RuntimeError('native_memory_restore_failed') from None
        finally:
            if process.poll() is None:process.kill();process.wait()
            if process.stdin and not process.stdin.closed:
                try:process.stdin.close()
                except OSError:pass
            if process.stdout:process.stdout.close()
        return {'restored_tables':len(TABLES),'automatic_activation':False,'provider_calls':0}


def restore_honcho(state,directory):
    from .configuration import compose_command,compose_environment
    from .store_recovery import assert_no_state_writers
    state=Path(state).resolve();marker=state/'spool/.restore-inactive'
    if marker.is_symlink() or not marker.is_file():raise ValueError('native_memory_restore_requires_inactive_installation')
    command=compose_command(state);environment=compose_environment(state)
    running=subprocess.check_output(command+['ps','--services','--status','running'],env=environment,text=True).split()
    if set(running)-{'nocheh-db','honcho-postgres','inngest-redis'}:raise ValueError('native_memory_restore_writers_active')
    assert_no_state_writers(state,environment,command)
    return NativeMemoryExport(command,environment).restore_inactive(directory)


def export_honcho(state,directory):
    from .configuration import load,compose_command,compose_environment
    values=load(state)
    if values.get('NOCHEH_HONCHO_ENABLED')!='true' and not values.get('NOCHEH_HONCHO_DATABASE_VOLUME'):
        return {'included':False,'reason':'not_configured'}
    result=NativeMemoryExport(compose_command(state),compose_environment(state)).export(directory)
    return {'included':True,**result}


def validate_honcho(directory):
    directory=Path(directory);metadata=directory/'manifest.json'
    if directory.is_symlink() or metadata.is_symlink():raise ValueError('native_memory_path_denied')
    manifest=json.loads(metadata.read_text())
    if manifest.get('format')!='nocheh-honcho-memory-v1' or manifest.get('complete') is not True or manifest.get('automatic_activation') is not False:
        raise ValueError('native_memory_manifest_invalid')
    if not isinstance(manifest.get('tables'),dict) or set(manifest['tables'])!=set(TABLES) or not IDENTIFIER.fullmatch(str(manifest.get('schema',''))):raise ValueError('native_memory_tables_invalid')
    if not re.fullmatch('[a-f0-9]{40}',str(manifest.get('producer_revision',''))):raise ValueError('native_memory_revision_invalid')
    for table,item in manifest['tables'].items():
        path=directory/(table+'.ndjson')
        if path.is_symlink() or not path.is_file() or path.stat().st_size!=item.get('size') or file_digest(path)!=item.get('sha256'):raise ValueError('native_memory_integrity_failed')
        columns=item.get('columns')
        if not isinstance(columns,list) or not columns or len(columns)>200 or any(not isinstance(c,dict) or not isinstance(c.get('name'),str) or not isinstance(c.get('type'),str) for c in columns):raise ValueError('native_memory_columns_invalid')
        names=[c['name'] for c in columns]
        if len(set(names))!=len(names):raise ValueError('native_memory_columns_invalid')
        count=0
        with path.open('rb') as source:
            while line:=source.readline(72*1024*1024+1):
                if len(line)>72*1024*1024:raise ValueError('native_memory_row_too_large')
                value=json.loads(line);count+=1
                if not isinstance(value,dict) or set(value)!=set(names):raise ValueError('native_memory_row_invalid')
        if count!=item.get('rows'):raise ValueError('native_memory_count_mismatch')
    return manifest
