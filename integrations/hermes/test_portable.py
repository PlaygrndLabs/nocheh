import json,sqlite3,tempfile,unittest
from pathlib import Path
from scripts.portable import export_all
from scripts.compatibility import commands
from .native_memory import registered_profiles


class PortableTests(unittest.TestCase):
    def test_native_notes_wal_sessions_and_custom_profiles_without_credentials(self):
        class API:
            def call(self,*_):return {'records':[],'next':None}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'state/hermes/profiles/research';(home/'memories').mkdir(parents=True)
            (home/'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
            (home/'auth.json').write_text('{"token":"never-export-this"}')
            (home/'config.yaml').write_text('api_key: never-export-this\n')
            original=b'Native inference. Citation nocheh:event:'+b'a'*64+b'\r\n'
            (home/'memories/MEMORY.md').write_bytes(original)
            source=sqlite3.connect(home/'state.db');source.execute('PRAGMA journal_mode=WAL')
            source.execute('CREATE TABLE sessions(id text,content text)');source.execute('INSERT INTO sessions VALUES(?,?)',('native-session','Original history\0\r\n'));source.commit()
            self.assertEqual(registered_profiles(root/'state/hermes'),[home])
            try:manifest=export_all(root/'state',root/'export',API())
            finally:source.close()
            self.assertTrue(manifest['complete']);self.assertFalse(manifest['credentials_included'])
            self.assertEqual((root/'export/native/research/memories/MEMORY.md').read_bytes(),original)
            copied=sqlite3.connect(root/'export/native/research/state.db')
            try:self.assertEqual(copied.execute('SELECT content FROM sessions').fetchone()[0],'Original history\0\r\n')
            finally:copied.close()
            self.assertFalse(list((root/'export').rglob('auth.json')));self.assertFalse(list((root/'export').rglob('config.yaml')))
            self.assertNotIn('never-export-this',json.dumps(manifest))
            with self.assertRaises(FileExistsError):export_all(root/'state',root/'export',API())

    def test_native_export_rejects_symlinked_notes_and_profile_roots(self):
        from scripts.portable import export_native
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'hermes/profiles'/('nocheh-'+'a'*24);home.mkdir(parents=True)
            outside=root/'outside';outside.mkdir();(outside/'MEMORY.md').write_text('private fixture')
            (home/'memories').symlink_to(outside)
            with self.assertRaisesRegex(ValueError,'native_export_path_denied'):export_native(root/'hermes',root/'export')

    def test_closed_wal_database_exports_without_creating_native_wal_or_shm(self):
        from scripts.portable import export_native
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'hermes/profiles'/('nocheh-'+'b'*24);home.mkdir(parents=True)
            (home/'.memory.lock').touch()
            source=sqlite3.connect(home/'state.db');source.execute('PRAGMA journal_mode=WAL')
            source.execute('CREATE TABLE sessions(id text)');source.execute("INSERT INTO sessions VALUES('closed-session')");source.commit()
            source.execute('PRAGMA wal_checkpoint(TRUNCATE)');source.close()
            # SQLite on macOS can retain empty sidecars; model a fully closed,
            # checkpointed database as produced by the pinned Linux runtime.
            (home/'state.db-wal').unlink(missing_ok=True);(home/'state.db-shm').unlink(missing_ok=True)
            self.assertFalse((home/'state.db-wal').exists())
            files=set(home.iterdir());result=export_native(root/'hermes',root/'export')
            self.assertTrue(result[0]['sessions']);self.assertEqual(set(home.iterdir()),files)
            copied=sqlite3.connect(root/'export'/home.name/'state.db')
            try:self.assertEqual(copied.execute('SELECT id FROM sessions').fetchone()[0],'closed-session')
            finally:copied.close()

    def test_candidates_cannot_mount_production_or_change_live_tags(self):
        revision='a'*40;runtime,dashboard,steps=commands(revision)
        self.assertNotIn('nocheh-hermes:local',(runtime,dashboard))
        self.assertNotIn('nocheh-dashboard:local',(runtime,dashboard))
        test_command=steps[1][1]
        self.assertIn('--network=none',test_command);self.assertIn('--read-only',test_command)
        self.assertNotIn('--mount',test_command);self.assertNotIn('-v',test_command)
        # A fixed fixture token permits module initialization without inheriting
        # any real installation token or mounting credentials.
        self.assertIn('SERVICE_TOKEN='+'0'*64,test_command)
        self.assertNotIn('SERVICE_TOKEN',test_command)
        self.assertEqual(dashboard,runtime)
        self.assertEqual(steps[2][0],'dashboard_assets')
        self.assertIn(runtime,steps[2][1])
        for value in ('main','../escape','a'*39,'A'*40):
            with self.assertRaises(ValueError):commands(value)

    def test_migrated_native_history_remains_portable(self):
        from scripts.portable import export_native
        from scripts.security_profiles import convert
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'hermes/profiles'/('nocheh-'+'c'*24);home.mkdir(parents=True)
            source=sqlite3.connect(home/'state.db');source.execute('CREATE TABLE sessions(content text)')
            source.execute('INSERT INTO sessions VALUES(?)',('Exact preserved history 😃\r\n',));source.commit();source.close()
            convert(home);result=export_native(root/'hermes',root/'export')
            self.assertTrue(result[0]['sessions']);self.assertFalse((home/'state.db').exists())
            copied=sqlite3.connect(root/'export'/home.name/'state.db')
            try:self.assertEqual(copied.execute('SELECT content FROM sessions').fetchone()[0],'Exact preserved history 😃\r\n')
            finally:copied.close()


if __name__=='__main__':unittest.main()
