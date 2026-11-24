import json,sqlite3,tempfile,unittest
from pathlib import Path
from tools.operations.archive.archive import canonical,digest,file_digest
from tools.operations.archive.portable import export_all,import_all,validate_package
from tools.operations.memory.honcho_portable import TABLES,validate_honcho


class API:
    storage_layout='original-only-v1'
    def __init__(self):
        self.calls=[];self.fail=False
        self.bytes=b'original media\x00\xff\r\n';self.event={'origin':'import','key':'fixture'}
        self.record={'id':'a'*64,'event':self.event,'artifacts':[{'id':'b'*64,'state':'ready','file_hash':digest(self.bytes),'byte_size':len(self.bytes)}]}
        value={'id':'c'*64,'content':'owner-edited guarded history','source_id':'events:'+self.record['id'],'revision':1,'operation_id':'fixture'}
        self.guard={'format':'nocheh-derivative-record-v1','type':'guard_sources','key':'events:'+self.record['id'],'value':{'id':'events:'+self.record['id'],'kind':'events','source_id':self.record['id'],'event_id':self.record['id'],'active_revision':1},'sha256':'d'*64}
        task={'id':'e'*64,'title':'Send the garden plan','tags':['home'],'due_on':'2026-12-01','position':1.5}
        self.task={'format':'nocheh-owner-record-v1','table':'owner_tasks','key':[task['id']],'row':task,'sha256':digest(canonical({'table':'owner_tasks','key':[task['id']],'row':task}))}
        chat={'id':'f'*64,'kind':'group','state':'active'}
        self.chat={'format':'nocheh-owner-record-v1','table':'chats','key':['group',chat['id']],'row':chat,'sha256':digest(canonical({'table':'chats','key':['group',chat['id']],'row':chat}))}
        self.derived={'format':'nocheh-derivative-record-v1','type':'guard_revisions','key':value['id'],'value':value,'sha256':digest(canonical({'type':'guard_revisions','key':value['id'],'value':value}))}
    def call(self,path,body=None,binary=False):
        if path.startswith('/v1/exports/sources?'):return {'format':'nocheh-sources-v1','records':[self.record],'next':None}
        if path.endswith('/bytes') and body is None:return self.bytes
        if path.endswith('/types'):return {'format':'nocheh-derivatives-v1','types':['guard_sources','guard_revisions']}
        if path.startswith('/v1/exports/derivatives?'):return {'format':'nocheh-derivatives-v1','records':[self.guard if 'type=guard_sources' in path else self.derived],'next':None}
        if path=='/v1/exports/owner-data/tables':return {'format':'nocheh-owner-data-v1','tables':['chats','owner_task_settings','owner_tasks']}
        if path.startswith('/v1/exports/owner-data?table=chats'):return {'format':'nocheh-owner-data-v1','table':'chats','records':[self.chat],'next':None}
        if path.startswith('/v1/exports/owner-data?'):return {'format':'nocheh-owner-data-v1','table':'owner_tasks','records':[self.task],'next':None} if 'table=owner_tasks' in path else {'format':'nocheh-owner-data-v1','table':'owner_task_settings','records':[],'next':None}
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
        (home/'cron').mkdir();(home/'cron/jobs.json').write_text('{"jobs":[{"id":"morning","schedule":"0 8 * * *"}]}')
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
            self.assertIn(('/v1/imports/owner-data',{'records':[api.task]}),api.calls)
            self.assertEqual(manifest['owner']['records'],2)
            # The package's chats come before its archive, so each original finds the chat the package names.
            first=next(index for index,(path,_) in enumerate(api.calls) if path=='/v1/imports/sources')
            self.assertEqual(api.calls[first-1],('/v1/imports/owner-data',{'records':[api.chat]}))
            self.assertLess(api.calls.index(('/v1/imports/owner-data',{'records':[api.chat]})),api.calls.index(('/v1/imports/sources',api.record)))
            self.assertIn('morning',(root/'inactive/native'/profile/'cron/jobs.json').read_text())
            # User changes to staged native notes must survive a later replay.
            (root/'inactive/native'/profile/'memories/USER.md').write_text('Owner correction')
            with self.assertRaisesRegex(ValueError,'destination_conflict'):import_all(root/'package',root/'inactive',api)
            self.assertEqual((root/'inactive/native'/profile/'memories/USER.md').read_text(),'Owner correction')

    def test_who_wrote_each_note_travels_with_the_notes_and_a_bad_record_file_is_left_behind(self):
        # ADR-0257: the parent-written record file goes and comes back with its profile; one that is not well formed is
        # neither exported nor restored, so its notes read as not recorded, and each time is counted.
        from services.hermes import note_sources
        records={note_sources.key('user','Native notes'):{'origins':[{'by':'review','review':'b'*64}],'more':0,'at':'2026-11-08'}}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);home=root/'state/hermes/profiles'/('nocheh-'+'a'*24);home.mkdir(parents=True)
            note_sources.save(home,records);(root/'state/hermes/usage').mkdir()
            api,manifest=self.prepare(root);profile=manifest['native_profiles'][0]['profile']
            self.assertIn('native/'+profile+'/'+note_sources.SIDECAR,manifest['files'])
            import_all(root/'package',root/'inactive',api)
            self.assertEqual(note_sources.load(root/'inactive/native'/profile),records)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);home=root/'state/hermes/profiles'/('nocheh-'+'a'*24);home.mkdir(parents=True)
            (home/note_sources.SIDECAR).write_text('{"version":1,"entries":"forged"}');(root/'state/hermes/usage').mkdir()
            api,manifest=self.prepare(root)
            self.assertFalse(any(name.endswith(note_sources.SIDECAR) for name in manifest['files']))
            counted=sqlite3.connect(root/'state/hermes/usage/usage.sqlite')
            try:self.assertEqual(counted.execute("SELECT kind,failed FROM note_daily").fetchall(),[('restore',1)])
            finally:counted.close()

    def test_what_each_carried_note_rests_on_travels_with_it_and_is_checked_again(self):
        # ADR-0291: a carried note's dependencies go with its profile, marked unchecked so the first turn after a restore
        # looks them up again; an altered file stops the restore before anything is written.
        from services.hermes.retired_history import DEPENDENCIES,load_dependencies,save_dependencies
        entries={'c'*64:{'turn':['d'*64],'sources':['e'*64]}}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);home=root/'state/hermes/profiles'/('nocheh-'+'a'*24);home.mkdir(parents=True)
            save_dependencies(home,'4:2026-11-08',entries)
            api,manifest=self.prepare(root);profile=manifest['native_profiles'][0]['profile']
            import_all(root/'package',root/'inactive',api)
            self.assertEqual(load_dependencies(root/'inactive/native'/profile),{'checked':None,'entries':entries})
            exported=root/'package/native'/profile/DEPENDENCIES
            exported.write_text(json.dumps({'version':1,'checked':'4:2026-11-08','entries':entries}))
            manifest['files']['native/'+profile+'/'+DEPENDENCIES]={'size':exported.stat().st_size,'sha256':file_digest(exported)}
            (root/'package/manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError,'portable_note_dependencies_invalid'):validate_package(root/'package')

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
        from tools.operations.memory.honcho_portable import restore_honcho
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with patch('tools.operations.memory.honcho_portable.subprocess.check_output') as process:
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
