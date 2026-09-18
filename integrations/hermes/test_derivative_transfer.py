import io,json,tempfile,unittest,urllib.error
from pathlib import Path
from scripts.archive import digest,file_digest
from scripts.derivative_transfer import export_derivatives,import_derivatives,validate_derivatives


def record(key,parent=None):
    value={'id':key,'provenance':{'parents':[{'id':parent}] if parent else []}}
    return {'format':'nocheh-derivative-record-v1','type':'derived_artifacts','key':key,'value':value,'sha256':digest(key)}


class DerivativeTransferTests(unittest.TestCase):
    def test_parent_order_history_dedup_and_complete_verification(self):
        child,parent=record('child','parent'),record('parent')
        class API:
            def __init__(self):self.saved=[];self.verified=[]
            def call(self,path,body=None):
                if path.endswith('/types'):return {'format':'nocheh-derivatives-v1','types':['derived_artifacts']}
                if path.startswith('/v1/exports/derivatives?'):return {'format':'nocheh-derivatives-v1','records':[child,parent],'next':None}
                if path.startswith('/v1/exports/derivative-history?'):return {'format':'nocheh-derivative-history-v1','records':[parent],'next':None}
                item=body['records'][0]
                if path.endswith('/verify'):self.verified.append(item['key']);return {}
                if item['key']=='child' and 'parent' not in self.saved:
                    raise urllib.error.HTTPError(path,409,'parent pending',{},io.BytesIO(b'{"error":"portable_parent_pending"}'))
                self.saved.append(item['key']);return {}
        api=API()
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'derivatives';manifest=export_derivatives(api,folder)
            self.assertTrue(manifest['complete']);self.assertEqual(manifest['records'],3)
            self.assertEqual(import_derivatives(api,folder),{'imported':2,'automatic_activation':False})
            self.assertEqual(api.saved,['parent','child']);self.assertEqual(set(api.verified),{'parent','child'})
            (folder/'records.ndjson').write_text('{}\n');before=list(api.saved)
            with self.assertRaisesRegex(ValueError,'derivative_records_integrity_failed'):import_derivatives(api,folder)
            self.assertEqual(api.saved,before)

    def test_missing_parents_never_turn_into_a_successful_import(self):
        class API:
            def call(self,path,body=None):
                if path.endswith('/types'):return {'format':'nocheh-derivatives-v1','types':['derived_artifacts']}
                if path.startswith('/v1/exports/derivative-history?'):return {'format':'nocheh-derivative-history-v1','records':[],'next':None}
                if path.startswith('/v1/exports/derivatives?'):return {'format':'nocheh-derivatives-v1','records':[record('orphan','missing')],'next':None}
                raise urllib.error.HTTPError(path,409,'pending',{},io.BytesIO(b'{"error":"portable_parent_pending"}'))
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'derivatives';api=API();export_derivatives(api,folder)
            with self.assertRaisesRegex(ValueError,'derivative_parents_missing_or_cyclic'):import_derivatives(api,folder)

    def test_record_counts_and_non_data_schema_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root);(folder/'records.ndjson').write_text(json.dumps(record('one'))+'\n')
            manifest={'format':'nocheh-derivatives-v1','complete':True,'types':['derived_artifacts'],'records':2,'records_sha256':file_digest(folder/'records.ndjson')}
            (folder/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'derivative_record_count_mismatch'):validate_derivatives(folder)
            manifest.update(records=1,types=['derived_artifacts;DROP TABLE'])
            (folder/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'derivative_types_invalid'):validate_derivatives(folder)


if __name__=='__main__':unittest.main()
