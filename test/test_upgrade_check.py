"""tools/acceptance/upgrade_check.py: what an upgrade of the tester copy counts, swaps and calls lost."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from tools.acceptance import upgrade_check


class UpgradeCheckTests(unittest.TestCase):
    def test_a_table_gone_or_smaller_is_lost_and_growth_is_not(self):
        before = {'a': 3, 'b': 2, 'c': 1, 'd': 0}
        after = {'a': 3, 'b': 1, 'd': 5, 'e': 9}
        self.assertEqual(upgrade_check.lost(before, after), {'b': [2, 1], 'c': [1, None]})

    def test_hermes_tables_and_kept_files_are_counted_from_the_state_folders(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory/'state/hermes/profiles/owner').mkdir(parents=True)
            with sqlite3.connect(directory/'state/hermes/profiles/owner/state.db') as database:
                database.execute('CREATE TABLE messages (text)')
                database.executemany('INSERT INTO messages VALUES (?)', [('one',), ('two',)])
            (directory/'state/files/a').mkdir(parents=True)
            (directory/'state/files/a/kept.pdf').write_bytes(b'%PDF')
            self.assertEqual(upgrade_check.hermes_counts(directory), {'hermes profiles/owner messages': 2})
            self.assertEqual(upgrade_check.file_count(directory), {'kept files': 1})

    def test_images_are_swapped_by_id_in_the_compose_file_and_the_fixture_record(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory/'fixture.json').write_text(json.dumps({'project': 'p', 'images': {'native': 'sha256:old-native',
                                                                                        'services': 'sha256:old-services'}}))
            (directory/'compose.json').write_text(json.dumps({'services': {
                'hermes': {'image': 'sha256:old-native', 'environment': {'NOCHEH_TURN_IMAGE': 'sha256:old-native'}},
                'nocheh-app': {'image': 'sha256:old-services'}, 'nocheh-miniapp': {'image': 'sha256:old-miniapp'}}}))
            ids = {'nocheh-hermes:tester': 'sha256:new-native', 'nocheh-miniapp:tester': 'sha256:new-miniapp',
                   'nocheh-services:tester': 'sha256:new-services'}
            with patch('subprocess.check_output', lambda command, text: json.dumps([{'Id': ids[command[-1]]}])):
                upgrade_check.swap_images(directory, {'native': 'nocheh-hermes:tester', 'miniapp': 'nocheh-miniapp:tester',
                                                      'services': 'nocheh-services:tester'})
            services = json.loads((directory/'compose.json').read_text())['services']
            self.assertEqual((services['hermes']['image'], services['hermes']['environment']['NOCHEH_TURN_IMAGE'],
                              services['nocheh-app']['image'], services['nocheh-miniapp']['image']),
                             ('sha256:new-native', 'sha256:new-native', 'sha256:new-services', 'sha256:new-miniapp'))
            self.assertEqual(json.loads((directory/'fixture.json').read_text())['images'],
                             {'native': 'sha256:new-native', 'services': 'sha256:new-services'})


if __name__ == '__main__':
    unittest.main()
