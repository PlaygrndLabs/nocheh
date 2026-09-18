"""Synthetic PostgreSQL-only native memory snapshot check; no Honcho provider calls."""
import argparse,json,os,subprocess,tempfile,uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts.honcho_portable import NativeMemoryExport,TABLES,validate_honcho

parser=argparse.ArgumentParser();parser.add_argument('--env-file',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
command=['docker','compose','--env-file',args.env_file,'-f',str(root/'compatibility/stores-compose.yml')]
prefix=command+['exec','-T','database','psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh']
def query(database,sql):return subprocess.check_output(prefix+['-d',database,'-c',sql],text=True,stderr=subprocess.DEVNULL).strip()
if query('nocheh',"SELECT current_setting('cluster_name')")!='nocheh-stores-fixture':raise SystemExit('Synthetic fixture marker required')
database='portable_native_'+uuid.uuid4().hex
query('nocheh','CREATE DATABASE '+database)
try:
    for table in TABLES:
        query(database,'CREATE TABLE '+table+'(id text PRIMARY KEY,content text,embedding jsonb); INSERT INTO '+table+" VALUES('synthetic','Exact native fact', '[0.5,0.75]')")
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
        print(json.dumps({'passed':True,'tables':len(TABLES),'consistent_snapshot':True,'native_queues_exported':False,'provider_calls':0}))
finally:query('nocheh','DROP DATABASE '+database)
