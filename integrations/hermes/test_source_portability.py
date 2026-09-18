import base64,json,tempfile,unittest
from pathlib import Path
from scripts.archive import digest,export_archive,import_archive


class SourcePortabilityTests(unittest.TestCase):
    def test_source_only_roundtrip_and_preflight_before_any_import(self):
        data=b'original\x00\xff\r\n';checksum=digest(data)
        record={'id':'a'*64,'event':{'origin':'live','text':'Original'},'artifacts':[
            {'id':'b'*64,'state':'ready','file_hash':checksum,'byte_size':len(data)}]}
        class API:
            def __init__(self):self.writes=[]
            def call(self,path,body=None,binary=False):
                if body is not None:self.writes.append((path,body));return {}
                if binary:return data
                assert path.startswith('/v1/exports/sources?')
                return {'format':'nocheh-sources-v1','records':[record],'next':None}
        api=API()
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'sources';manifest=export_archive(api,folder,True)
            self.assertTrue(manifest['complete']);self.assertFalse(manifest['derivatives_included'])
            self.assertEqual((folder/'files'/checksum).read_bytes(),data)
            self.assertEqual((folder/'events.ndjson').stat().st_mode&0o777,0o600)
            self.assertEqual(import_archive(api,folder),{'imported':1,'telegram_replies':0})
            self.assertEqual(api.writes[0],('/v1/imports/sources',record))
            self.assertEqual(api.writes[1][0],'/v1/original-files/'+'b'*64+'/bytes')
            self.assertEqual(base64.b64decode(api.writes[1][1]['bytes_base64']),data)
            api.writes.clear();(folder/'files'/checksum).write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError,'artifact_integrity_failed'):import_archive(api,folder)
            self.assertEqual(api.writes,[])
            (folder/'files'/checksum).write_bytes(data)
            (folder/'events.ndjson').write_text('{}\n')
            with self.assertRaisesRegex(ValueError,'source_records_integrity_failed'):import_archive(api,folder)
            self.assertEqual(api.writes,[])

    def test_generated_or_guarded_data_cannot_be_published_as_source_only(self):
        class API:
            def call(self,*args,**kwargs):return {'format':'nocheh-sources-v1','records':[{'event':{'origin':'live'},'guarded':{}}],'next':None}
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'sources'
            with self.assertRaisesRegex(ValueError,'original_source_required'):export_archive(API(),folder,True)
            self.assertFalse(json.loads((folder/'manifest.json').read_text())['complete'])

    def test_file_integrity_failure_leaves_export_incomplete(self):
        class API:
            def call(self,path,body=None,binary=False):
                if binary:return b'wrong'
                return {'format':'nocheh-sources-v1','records':[{'event':{'origin':'import'},'artifacts':[
                    {'id':'a'*64,'state':'ready','file_hash':digest(b'original'),'byte_size':8}]}],'next':None}
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'sources'
            with self.assertRaisesRegex(ValueError,'artifact_integrity_failed'):export_archive(API(),folder,True)
            self.assertFalse(json.loads((folder/'manifest.json').read_text())['complete'])


if __name__=='__main__':unittest.main()
