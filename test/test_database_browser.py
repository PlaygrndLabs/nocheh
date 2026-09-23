import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scripts import database_browser


class DatabaseBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name)
        profile = self.state / 'hermes/profiles/research'
        (profile / 'native-state').mkdir(parents=True)
        (profile / 'nocheh-owner-profile.json').write_text('{}')
        self.sqlite = profile / 'native-state/state.db'
        with closing(sqlite3.connect(self.sqlite)) as connection:
            connection.execute('CREATE TABLE messages (id INTEGER, content TEXT, data BLOB)')
            connection.executemany('INSERT INTO messages VALUES (?,?,?)', [
                (2, 'Second greeting', b'\x00\xff'), (1, 'First greeting', b'\x01')])
            connection.commit()
        provider = self.state / 'provider/monitor/usage.sqlite'
        provider.parent.mkdir(parents=True)
        with closing(sqlite3.connect(provider)) as connection:
            connection.execute('CREATE TABLE usage (tokens INTEGER)')
            connection.commit()
        ledger = self.state / 'honcho/ledger/budget.sqlite'
        ledger.parent.mkdir(parents=True)
        with closing(sqlite3.connect(ledger)) as connection:
            connection.execute('CREATE TABLE reservations (cost INTEGER)')
            connection.commit()
        self.config = patch.object(database_browser, 'load', return_value={
            'NOCHEH_STORAGE_LAYOUT': 'original-only-v1', 'NOCHEH_HONCHO_ENABLED': 'true'})
        self.config.start()

    def tearDown(self):
        self.config.stop()
        self.temporary.cleanup()

    def test_catalog_covers_configured_postgres_and_registered_sqlite(self):
        result = database_browser.view(self.state, {'action': 'databases'})
        self.assertEqual([item['id'] for item in result['databases']],
                         ['archive', 'derived', 'control', 'workflow', 'honcho',
                          'hermes:research', 'provider-usage', 'honcho-ledger'])
        self.assertNotIn('path', str(result))
        tables = database_browser.view(self.state, {'action': 'tables', 'database': 'hermes:research'})
        self.assertIn({'schema': 'main', 'name': 'messages', 'estimated_rows': None}, tables['tables'])

    def test_sqlite_rows_sort_filter_and_reject_unknown_columns(self):
        selected = {'action': 'rows', 'database': 'hermes:research', 'schema': 'main', 'table': 'messages'}
        result = database_browser.view(self.state, {**selected, 'sort': 'id', 'direction': 'desc',
                                                    'filter_column': 'content', 'filter': 'greeting'})
        self.assertEqual([row['id'] for row in result['rows']], ['2', '1'])
        self.assertEqual(result['rows'][0]['data'], '00FF')
        self.assertIsNone(result['next_offset'])
        with self.assertRaisesRegex(ValueError, 'invalid_column'):
            database_browser.view(self.state, {**selected, 'sort': 'content; DROP TABLE messages'})
        with closing(sqlite3.connect(self.sqlite)) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM messages').fetchone()[0], 2)

    def test_postgres_filter_is_encoded_and_columns_are_whitelisted(self):
        queries = []
        with patch.object(database_browser, '_pg', side_effect=lambda state, db, query: queries.append(query) or []):
            database_browser._rows_pg(self.state, {}, 'public', 'events', [{'name': 'text'}],
                                      'text', 'asc', 'text', "x'; DROP TABLE events; --", 0)
            self.assertNotIn('DROP TABLE', queries[0])
            self.assertIn('source."text"', queries[0])
            with self.assertRaisesRegex(ValueError, 'invalid_column'):
                database_browser._rows_pg(self.state, {}, 'public', 'events', [{'name': 'text'}],
                                          'missing', 'asc', '', '', 0)

    def test_status_includes_details_and_keeps_unavailable_stores_visible(self):
        with patch.object(database_browser, '_pg', side_effect=ValueError('database_unavailable')):
            result = database_browser.view(self.state, {'action': 'status'})['databases']
        by_id = {item['id']: item for item in result}
        self.assertEqual(by_id['archive']['state'], 'unavailable')
        self.assertEqual(by_id['hermes:research']['state'], 'available')
        self.assertEqual(by_id['hermes:research']['table_count'], 1)
        self.assertEqual(by_id['hermes:research']['identifier'], 'state.db')
        self.assertNotIn(str(self.state), str(result))
        self.sqlite.unlink()
        with patch.object(database_browser, '_pg', side_effect=ValueError('database_unavailable')):
            missing = database_browser.view(self.state, {'action': 'status'})['databases']
        self.assertEqual(next(item for item in missing if item['id'] == 'hermes:research')['state'], 'missing')


if __name__ == '__main__':
    unittest.main()
