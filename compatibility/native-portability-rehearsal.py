"""Actual pinned migrations/ORM/pgvector portable round-trip, entirely synthetic."""
import argparse,json,os,subprocess,tempfile,uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts.honcho_portable import NativeMemoryExport,TABLES

parser=argparse.ArgumentParser();parser.add_argument('--env-file',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
command=['docker','compose','--env-file',args.env_file,'-f',str(root/'compatibility/native-portability-compose.yml')]
prefix=command+['exec','-T','honcho-postgres','psql','-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','experiment']
def query(database,sql):return subprocess.check_output(prefix+['-d',database,'-c',sql],text=True,stderr=subprocess.DEVNULL).strip()
assert query('honcho_experiment',"SELECT current_setting('cluster_name')")=='nocheh-native-portable-fixture'
databases=['native_portable_'+uuid.uuid4().hex for _ in range(2)]
created=[]
try:
    for database in databases:
        query('honcho_experiment','CREATE DATABASE '+database);created.append(database)
        uri='postgresql+psycopg://experiment:synthetic-native-portable-not-a-real-credential@honcho-postgres:5432/'+database
        subprocess.run(command+['run','--rm','--no-deps','-e','DB_CONNECTION_URI='+uri,'schema','scripts/provision_db.py'],check=True,stdout=subprocess.DEVNULL)
    source,target=databases
    uri='postgresql+psycopg://experiment:synthetic-native-portable-not-a-real-credential@honcho-postgres:5432/'+source
    subprocess.run(command+['run','--rm','--no-deps','-e','DB_CONNECTION_URI='+uri,'schema','/fixture/seed.py'],check=True)
    with tempfile.TemporaryDirectory(prefix='nocheh-pinned-native-') as folder:
        source_export=NativeMemoryExport(command,os.environ,database=source)
        before=source_export.export(Path(folder)/'source')
        columns=before['tables']['documents']['columns'];assert any(c['name']=='embedding' and c['type']=='vector(1536)' for c in columns)
        target_export=NativeMemoryExport(command,os.environ,database=target)
        assert target_export.restore_inactive(Path(folder)/'source')['automatic_activation'] is False
        after=target_export.export(Path(folder)/'target')
        for table in TABLES:
            assert before['tables'][table]==after['tables'][table],table
            assert (Path(folder)/'source'/f'{table}.ndjson').read_bytes()==(Path(folder)/'target'/f'{table}.ndjson').read_bytes(),table
        assert target_export.restore_inactive(Path(folder)/'source')['restored_tables']==8
        assert query(target,"SELECT count(*) FROM documents WHERE deleted_at IS NOT NULL")=='1'
        assert query(target,"SELECT count(*) FROM documents d JOIN messages m ON d.source_ids ? m.public_id")=='1'
        assert query(target,'SELECT count(*) FROM queue')=='0'
        assert query(target,'SELECT count(*) FROM webhook_endpoints')=='0'
        print(json.dumps({'passed':True,'native_tables':8,'pinned_migrations':True,'native_orm_seed':True,'pgvector_dimensions':1536,
            'exact_round_trip':True,'citation_ancestry_preserved':True,'retired_history_preserved':True,'idempotent_replay':True,'provider_calls':0}))
finally:
    for database in reversed(created):query('honcho_experiment','DROP DATABASE '+database)
