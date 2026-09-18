"""Synthetic PostgreSQL-only native memory snapshot check; no Honcho provider calls."""
import argparse,json,os,shutil,subprocess,tempfile,uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts.honcho_portable import NativeMemoryExport,TABLES,validate_honcho
from scripts.archive import file_digest

parser=argparse.ArgumentParser();parser.add_argument('--env-file',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
command=['docker','compose','--env-file',args.env_file,'-f',str(root/'compatibility/stores-compose.yml')]
prefix=command+['exec','-T','database','psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh']
def query(database,sql):return subprocess.check_output(prefix+['-d',database,'-c',sql],text=True,stderr=subprocess.DEVNULL).strip()
if query('nocheh',"SELECT current_setting('cluster_name')")!='nocheh-stores-fixture':raise SystemExit('Synthetic fixture marker required')
database='portable_native_'+uuid.uuid4().hex
target='portable_target_'+uuid.uuid4().hex
query('nocheh','CREATE DATABASE '+database);query('nocheh','CREATE DATABASE '+target)
try:
    for table in TABLES:
        columns='(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,content text,embedding jsonb)' if table=='messages' else '(id text PRIMARY KEY,content text,embedding jsonb)'
        query(database,'CREATE TABLE '+table+columns);query(target,'CREATE TABLE '+table+columns)
        query(database,'INSERT INTO '+table+"(content,embedding) VALUES('Exact native fact','[0.5,0.75]')" if table=='messages' else 'INSERT INTO '+table+" VALUES('synthetic','Exact native fact', '[0.5,0.75]')")
    query(target,'CREATE TABLE queue(secret text); CREATE TABLE webhook_endpoints(url text)')
    query(database,"CREATE TABLE queue(secret text); INSERT INTO queue VALUES('never-export-operational-work'); CREATE TABLE webhook_endpoints(url text)")
    class ConcurrentExport(NativeMemoryExport):
        changed=False
        def query(self,snapshot,sql,output=None):
            result=super().query(snapshot,sql,output)
            if output and not self.changed:
                self.changed=True
                query(database,"UPDATE peers SET content='Later native fact'")
            return result
    with tempfile.TemporaryDirectory(prefix='nocheh-native-portable-') as folder:
        directory=Path(folder)/'memory';metadata=ConcurrentExport(command,os.environ,service='database',database=database,user='nocheh').export(directory)
        assert validate_honcho(directory)==metadata
        assert set(metadata['tables'])==set(TABLES)
        assert json.loads((directory/'peers.ndjson').read_text())['content']=='Exact native fact'
        assert query(database,'SELECT content FROM peers')=='Later native fact'
        assert not (directory/'queue.ndjson').exists() and not (directory/'webhook_endpoints.ndjson').exists()
        for table in TABLES:
            row=json.loads((directory/(table+'.ndjson')).read_text());assert row['embedding']==[0.5,0.75]
        restored=NativeMemoryExport(command,os.environ,service='database',database=target,user='nocheh')
        def must_fail(folder):
            try:restored.restore_inactive(folder)
            except RuntimeError:pass
            else:raise AssertionError('invalid or conflicting native import must fail')
        bad=Path(folder)/'bad';shutil.copytree(directory,bad)
        message=json.loads((bad/'messages.ndjson').read_text());message['id']='invalid bigint'
        (bad/'messages.ndjson').write_text(json.dumps(message)+'\n')
        invalid=json.loads((bad/'manifest.json').read_text());invalid['tables']['messages'].update(sha256=file_digest(bad/'messages.ndjson'),size=(bad/'messages.ndjson').stat().st_size)
        (bad/'manifest.json').write_text(json.dumps(invalid));must_fail(bad)
        assert query(target,'SELECT count(*) FROM workspaces')=='0'
        query(target,"INSERT INTO queue VALUES('pending fixture')");must_fail(directory);query(target,'DELETE FROM queue')
        query(target,'ALTER TABLE peers ADD COLUMN unexpected text');must_fail(directory);query(target,'ALTER TABLE peers DROP COLUMN unexpected')
        assert restored.restore_inactive(directory)['restored_tables']==8
        assert restored.restore_inactive(directory)['automatic_activation'] is False
        assert query(target,'SELECT content FROM peers')=='Exact native fact'
        assert query(target,"INSERT INTO messages(content) VALUES('new fixture') RETURNING id")=='2'
        query(target,"DELETE FROM messages WHERE content='new fixture'")
        query(target,"UPDATE peers SET content='Owner destination change'")
        try:restored.restore_inactive(directory)
        except RuntimeError:pass
        else:raise AssertionError('conflicting destination must fail')
        assert query(target,'SELECT content FROM peers')=='Owner destination change'
        print(json.dumps({'late_failure_atomic':True,'active_work_rejected':True,'schema_mismatch_rejected':True,'round_trip':True,'idempotent_replay':True,'destination_conflict_preserved':True,'identity_sequence_advanced':True,'passed':True,'tables':len(TABLES),'consistent_snapshot':True,'native_queues_exported':False,'provider_calls':0}))
finally:
    query('nocheh','DROP DATABASE '+database);query('nocheh','DROP DATABASE '+target)
