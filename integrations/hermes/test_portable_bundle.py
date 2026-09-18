import json,sqlite3,tempfile,unittest
from pathlib import Path
from scripts.archive import canonical,digest,file_digest
from scripts.portable import export_all,import_all,validate_package
from scripts.honcho_portable import TABLES,validate_honcho


class API:
    storage_layout='original-only-v1'
    def __init__(self):
        self.calls=[];self.fail=False
        self.bytes=b'original media\x00\xff\r\n';self.event={'origin':'import','key':'fixture'}
        self.record={'id':'a'*64,'event':self.event,'artifacts':[{'id':'b'*64,'state':'ready','file_hash':digest(self.bytes),'byte_size':len(self.bytes)}]}
        value={'id':'c'*64,'content':'owner-edited guarded history','source_id':'events:'+self.record['id'],'revision':1,'operation_id':'fixture'}
        self.guard={'format':'nocheh-derivative-record-v1','type':'guard_sources','key':'events:'+self.record['id'],'value':{'id':'events:'+self.record['id'],'kind':'events','source_id':self.record['id'],'event_id':self.record['id'],'active_revision':1},'sha256':'d'*64}
        self.derived={'format':'nocheh-derivative-record-v1','type':'guard_revisions','key':value['id'],'value':value,'sha256':digest(canonical({'type':'guard_revisions','key':value['id'],'value':value}))}
    def call(self,path,body=None,binary=False):
        if path.startswith('/v1/exports/sources?'):return {'format':'nocheh-sources-v1','records':[self.record],'next':None}
        if path.endswith('/bytes') and body is None:return self.bytes
        if path.endswith('/types'):return {'format':'nocheh-derivatives-v1','types':['guard_sources','guard_revisions']}
        if path.startswith('/v1/exports/derivatives?'):return {'format':'nocheh-derivatives-v1','records':[self.guard if 'type=guard_sources' in path else self.derived],'next':None}
        if path.startswith('/v1/exports/derivative-history?'):return {'format':'nocheh-derivative-history-v1','records':[],'next':None}
        if self.fail and path=='/v1/imports/derivatives':self.fail=False;raise RuntimeError('lost derivative acknowledgment')
        self.calls.append((path,body));return {}


def native_honcho(_state,directory):
    directory.mkdir(mode=0o700)
    manifest={'format':'nocheh-honcho-memory-v1','producer_revision':'a'*40,'automatic_activation':False,'schema':'public','tables':{},'complete':True}
    for table in TABLES:
        path=directory/(table+'.ndjson');value={'id':table,'content':'native fact with \n and "literal"','embedding':[0.5,0.75]}
        path.write_text(json.dumps(value)+'\n')
        manifest['tables'][table]={'columns':[{'name':key,'type':'jsonb' if key=='embedding' else 'text'} for key in value],
            'rows':1,'sha256':file_digest(path),'size':path.stat().st_size}
    (directory/'manifest.json').write_text(json.dumps(manifest))
    return {'included':True,**manifest}


class PortableBundleTests(unittest.TestCase):
    def prepare(self,root):
        home=root/'state/hermes/profiles'/('nocheh-'+'a'*24);(home/'memories').mkdir(parents=True)
        (home/'.memory.lock').touch();(home/'memories/USER.md').write_bytes(b'Native notes\r\n')
        (home/'space.json').write_text('{"space":"123","generation":"retired"}')
        database=sqlite3.connect(home/'state.db');database.execute('CREATE TABLE messages(text text)');database.execute('INSERT INTO messages VALUES(?)',('Saved native conversation',));database.commit();database.close()
        (home/'auth.json').write_text('SECRET_TOKEN_NOT_EXPORTABLE')
        api=API();manifest=export_all(root/'state',root/'package',api,honcho_export=native_honcho)
        return api,manifest

    def test_complete_domains_round_trip_and_inactive_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api,manifest=self.prepare(root)
            self.assertEqual(manifest['format'],'nocheh-portable-v2');self.assertTrue(manifest['complete'])
            self.assertEqual(validate_package(root/'package'),manifest)
            self.assertNotIn('auth.json',json.dumps(manifest));self.assertFalse(any('queue' in name for name in manifest['files']))
            self.assertTrue(manifest['honcho']['included']);api.fail=True
            with self.assertRaisesRegex(RuntimeError,'lost derivative'):import_all(root/'package',root/'inactive',api)
            self.assertFalse(json.loads((root/'inactive/import.json').read_text())['complete'])
            result=import_all(root/'package',root/'inactive',api)
            self.assertTrue(result['complete']);self.assertFalse(result['automatic_activation']);self.assertEqual(result['telegram_replies'],0)
            self.assertTrue((root/'inactive/.restore-inactive').is_file())
            self.assertEqual(validate_honcho(root/'inactive/honcho')['tables'],manifest['honcho']['tables'])
            profile=manifest['native_profiles'][0]['profile']
            self.assertEqual((root/'inactive/native'/profile/'memories/USER.md').read_bytes(),b'Native notes\r\n')
            db=sqlite3.connect(root/'inactive/native'/profile/'state.db')
            try:self.assertEqual(db.execute('SELECT text FROM messages').fetchone()[0],'Saved native conversation')
            finally:db.close()
            self.assertEqual(import_all(root/'package',root/'inactive',api)['bundle'],result['bundle'])
            self.assertIn(('/v1/imports/sources',api.record),api.calls)
            self.assertIn(('/v1/imports/derivatives',{'records':[api.derived]}),api.calls)
            # User changes to staged native notes must survive a later replay.
            (root/'inactive/native'/profile/'memories/USER.md').write_text('Owner correction')
            with self.assertRaisesRegex(ValueError,'destination_conflict'):import_all(root/'package',root/'inactive',api)
            self.assertEqual((root/'inactive/native'/profile/'memories/USER.md').read_text(),'Owner correction')

    def test_all_checks_precede_remote_import_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api,manifest=self.prepare(root)
            (root/'package/derivatives/records.ndjson').write_text('{}\n')
            with self.assertRaisesRegex(ValueError,'integrity'):import_all(root/'package',root/'inactive',api)
            self.assertEqual(api.calls,[]);self.assertFalse((root/'inactive').exists())
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api,_=self.prepare(root)
            (root/'package/native/escape').symlink_to(root/'state')
            with self.assertRaisesRegex(ValueError,'path_denied'):import_all(root/'package',root/'inactive',api)
            self.assertEqual(api.calls,[])

    def test_missing_source_or_revision_cannot_publish_complete_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api=API();api.guard['value']['source_id']='f'*64
            with self.assertRaisesRegex(ValueError,'reference_incomplete'):export_all(root/'state',root/'package',api,honcho_export=native_honcho)
            self.assertFalse(json.loads((root/'package/manifest.json').read_text())['complete'])
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api=API();api.guard['value']['active_revision']=2
            with self.assertRaisesRegex(ValueError,'history_incomplete'):export_all(root/'state',root/'package',api,honcho_export=native_honcho)
            self.assertFalse(json.loads((root/'package/manifest.json').read_text())['complete'])

    def test_configured_honcho_unavailable_never_marks_bundle_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            def unavailable(*_):raise RuntimeError('native store unavailable')
            with self.assertRaisesRegex(RuntimeError,'native store unavailable'):export_all(root/'state',root/'package',API(),honcho_export=unavailable)
            self.assertFalse(json.loads((root/'package/manifest.json').read_text())['complete'])

    def test_legacy_bundle_routes_generated_files_and_trusted_history_separately(self):
        class LegacyAPI(API):
            storage_layout='legacy'
            def call(self,path,body=None,binary=False):
                if path.startswith('/v1/export?'):return {'records':[{**self.record,'derived':[self.derived],'guarded':{'format':'nocheh-guarded-v1','sources':[]}}],'next':None}
                return super().call(path,body,binary)
        class Destination(API):
            def call(self,path,body=None,binary=False):
                if path.startswith('/v1/imports/legacy?'):
                    self.calls.append((path,body));return {'files':[{'id':'b'*64,'store':'derived'}]}
                return super().call(path,body,binary)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=LegacyAPI();source.record['artifacts'][0]['byte_size']=str(len(source.bytes));manifest=export_all(root/'state',root/'package',source)
            self.assertEqual(manifest['format'],'nocheh-portable-v1');self.assertEqual(validate_package(root/'package'),manifest)
            target=Destination();result=import_all(root/'package',root/'inactive',target,restore_guarded=True)
            self.assertTrue(result['complete']);self.assertFalse(result['honcho_included'])
            paths=[path for path,_ in target.calls]
            self.assertIn('/v1/imports/legacy?restore_guarded=true',paths)
            self.assertIn('/v1/imports/legacy/files/'+'b'*64+'/bytes',paths)
            self.assertFalse(any(path.startswith('/v1/imports/derivatives') for path in paths))

    def test_native_restore_requires_an_inactive_installation_before_any_process(self):
        from scripts.honcho_portable import restore_honcho
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch('scripts.honcho_portable.subprocess.check_output') as process:
                with self.assertRaisesRegex(ValueError,'requires_inactive'):restore_honcho(root,root/'memory')
                process.assert_not_called()

    def test_source_overlap_and_existing_unowned_destination_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);api,_=self.prepare(root)
            with self.assertRaisesRegex(ValueError,'overlaps'):import_all(root/'package',root/'package/nested',api)
            (root/'occupied').mkdir()
            with self.assertRaisesRegex(ValueError,'destination_exists'):import_all(root/'package',root/'occupied',api)
            self.assertEqual(api.calls,[])

if __name__=='__main__':unittest.main()
