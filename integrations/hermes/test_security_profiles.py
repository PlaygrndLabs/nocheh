import sqlite3
import tempfile
import unittest
from pathlib import Path
from scripts.security_profiles import convert
from .isolated_profile import database_path

class SecurityProfileTests(unittest.TestCase):
    def test_offline_history_is_preserved_and_repeat_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'config.yaml').write_text('{}')
            db=sqlite3.connect(root/'state.db');db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE messages(content TEXT)')
            value='Exact history 😃\r\n  whitespace';db.execute('INSERT INTO messages VALUES(?)',[value]);db.commit();db.close()
            first=convert(root);self.assertTrue(first['moved']);self.assertTrue(first['preserved'])
            self.assertFalse((root/'state.db').exists())
            db=sqlite3.connect(database_path(root));self.assertEqual(db.execute('SELECT content FROM messages').fetchone()[0],value);db.close()
            self.assertFalse(convert(root)['moved'])
    def test_ambiguous_layout_and_links_never_overwrite_history(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'state.db').write_text('original');(root/'native-state').mkdir();(root/'native-state'/'state.db').write_text('other')
            with self.assertRaisesRegex(ValueError,'ambiguous'):convert(root)
            self.assertEqual((root/'state.db').read_text(),'original');self.assertEqual((root/'native-state'/'state.db').read_text(),'other')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'native-state').symlink_to('/private')
            with self.assertRaisesRegex(ValueError,'profile_path_denied'):convert(root)

    def test_partial_conversion_keeps_legacy_history_visible(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'state.db').write_text('existing history');(root/'native-state').mkdir()
            self.assertEqual(database_path(root),root/'state.db')

    def test_native_default_reader_follows_the_same_history_path(self):
        import hermes_state
        from unittest.mock import patch
        from .isolated_profile import install_database_paths
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'native-state').mkdir();(root/'native-state'/'state.db').touch()
            with patch.object(hermes_state,'_default_db_path',lambda:root/'state.db'):
                restore=install_database_paths()
                try:self.assertEqual(hermes_state._default_db_path(),root/'native-state'/'state.db')
                finally:restore()

    def test_native_imports_cannot_create_a_temporary_legacy_database(self):
        import os,subprocess,sys
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'native-state').mkdir()
            code='''from integrations.hermes.isolated_profile import install_database_paths
install_database_paths()
import run_agent
from hermes_state import SessionDB
db=SessionDB();db.close()
'''
            result=subprocess.run([sys.executable,'-c',code],env={**os.environ,'HERMES_HOME':folder},capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr[-500:])
            self.assertTrue((root/'native-state'/'state.db').is_file())
            self.assertFalse((root/'state.db').exists())

if __name__=='__main__':unittest.main()
