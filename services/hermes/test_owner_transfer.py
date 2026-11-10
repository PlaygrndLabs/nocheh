import io,json,tempfile,unittest,urllib.error
from pathlib import Path
from tools.operations.archive.archive import canonical,digest
from tools.operations.archive.owner_transfer import export_owner,import_owner,validate_owner


def record(table,key,row):
    return {'format':'nocheh-owner-record-v1','table':table,'key':key,'row':row,'sha256':digest(canonical({'table':table,'key':key,'row':row}))}


class API:
    """Tasks come out child first, as key order can give them; the child waits for its parent."""
    def __init__(self,records,missing=()):
        self.records=records;self.missing=set(missing);self.stored=set();self.calls=[]
    def call(self,path,body=None):
        if path=='/v1/exports/owner-data/tables':return {'format':'nocheh-owner-data-v1','tables':['owner_tasks','sharing_rules']}
        if path.startswith('/v1/exports/owner-data?'):
            table='owner_tasks' if 'table=owner_tasks' in path else 'sharing_rules'
            after='after=&' not in path
            items=[r for r in self.records if r['table']==table]
            return {'format':'nocheh-owner-data-v1','table':table,'records':items[1:] if after else items[:1],'next':None if after or len(items)<2 else json.dumps(items[0]['key'])}
        task=body['records'][0];self.calls.append(task['key'][0])
        parent=task['row'].get('parent_id')
        if parent and (parent not in self.stored or parent in self.missing):
            raise urllib.error.HTTPError(path,409,'conflict',{},io.BytesIO(b'{"error":"portable_parent_pending"}'))
        self.stored.add(task['key'][0]);return {'added':1}


class OwnerTransferTests(unittest.TestCase):
    rows=[record('owner_tasks',['0'*64],{'id':'0'*64,'title':'Buy seeds','parent_id':'a'*64}),
          record('owner_tasks',['a'*64],{'id':'a'*64,'title':'Plan the beds','parent_id':None,'tags':['garden'],'position':2.75}),
          record('sharing_rules',['rule-1'],{'id':'rule-1','enabled':True})]

    def test_round_trip_pages_and_waits_for_parent_tasks(self):
        with tempfile.TemporaryDirectory() as folder:
            api=API(self.rows);manifest=export_owner(api,Path(folder)/'owner')
            self.assertEqual(manifest['records'],3);self.assertEqual(validate_owner(Path(folder)/'owner'),manifest)
            result=import_owner(api,Path(folder)/'owner')
            self.assertEqual(result,{'added':3,'unchanged':0,'kept':0,'automatic_activation':False})
            self.assertEqual(api.calls[:3],['0'*64,'a'*64,'0'*64])

    def test_missing_parent_stops_instead_of_looping(self):
        with tempfile.TemporaryDirectory() as folder:
            export_owner(API(self.rows),Path(folder)/'owner')
            with self.assertRaisesRegex(ValueError,'owner_parents_missing_or_cyclic'):import_owner(API(self.rows,missing=['a'*64]),Path(folder)/'owner')

    def test_changed_records_are_refused_before_any_import(self):
        with tempfile.TemporaryDirectory() as folder:
            export_owner(API(self.rows),Path(folder)/'owner');path=Path(folder)/'owner/records.ndjson'
            path.write_text(path.read_text().replace('Buy seeds','Buy bulbs'))
            api=API(self.rows)
            with self.assertRaisesRegex(ValueError,'owner_records_integrity_failed'):import_owner(api,Path(folder)/'owner')
            self.assertEqual(api.calls,[])


if __name__=='__main__':unittest.main()
