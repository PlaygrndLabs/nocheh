import fcntl
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import reset_accounting as reset

ROOT = Path(__file__).resolve().parents[2]
SENTINEL = 'ERASE_PRIVATE_CONVERSATION_5d481bbe'


def insert(db, table, **values):
    # Fill the pinned schema's required fields with synthetic accounting values.
    for _, name, kind, required, default, primary in db.execute('PRAGMA table_info(' + table + ')'):
        if name not in values and ((required and default is None) or (primary and kind == 'TEXT')):
            values[name] = 17 if kind == 'INTEGER' else 0.125 if kind == 'REAL' else 'fixture'
    columns = ','.join('"' + key + '"' for key in values)
    return db.execute('INSERT INTO ' + table + '(' + columns + ') VALUES(' + ','.join('?' for _ in values) + ')', list(values.values())).lastrowid


class ResetAccountingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'usage.sqlite'
        with sqlite3.connect(self.path) as db:
            db.executescript((ROOT / 'compatibility/fixtures/cpamp-reset-schema.sql').read_text())
            self.assertEqual(len(reset.schema(db)), 43)
            db.execute('PRAGMA journal_mode=WAL')
            insert(db, 'usage_events', id=-3, event_hash='negative-import', raw_json=json.dumps({'prompt': SENTINEL, 'usage': {'totalTokens': '700', 'cacheInputMode': 'separate_from_input'}}))
            insert(db, 'usage_events', id=1, event_hash='positive-import', input_tokens=410, output_tokens=80,
                   cache_input_mode='included_in_input', normalized_total_input_tokens=410,
                   total_tokens=490, raw_json=json.dumps({'detail': {'tokens': {'total_tokens': 490, 'cache_input_mode': 'included_in_input'}, 'messages': [SENTINEL]}}),
                   **{column: SENTINEL for column in reset.SCRUB['usage_events']})
            for table, columns in reset.SCRUB.items():
                if table != 'usage_events':
                    insert(db, table, **{column: SENTINEL for column in columns})
            for table in reset.ERASE:
                columns = {r[1]: r for r in db.execute('PRAGMA table_info(' + table + ')')}
                insert(db, table, **{name: SENTINEL for name, row in columns.items() if row[2] == 'TEXT'})
            insert(db, 'usage_pricing_account_rollups_v1', input_tokens=410, output_tokens=80, calls=2)
            insert(db, 'model_prices', model='fixture-model', prompt_per_1m=0.123456789, raw_json='{"pricing_only":true}')
            insert(db, 'settings', key='fixture_saved_preference', value='saved')
        self.before = self.fingerprint()

    def fingerprint(self):
        with sqlite3.connect(self.path) as db:
            return reset.fingerprint(db, reset.schema(db))

    def test_accounting_and_configuration_survive_but_content_and_fts_do_not(self):
        with sqlite3.connect(self.path) as db:
            self.assertGreater(db.execute("SELECT count(*) FROM usage_monitoring_event_search_v1 WHERE usage_monitoring_event_search_v1 MATCH 'ERA'").fetchone()[0], 0)
        result = reset.sanitize(self.path)
        self.assertTrue(result['accounting_preserved']); self.assertFalse(result['backup_created'])
        self.assertEqual(self.fingerprint(), self.before)
        with sqlite3.connect(self.path) as db:
            for table in reset.ERASE:
                self.assertEqual(db.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM usage_monitoring_event_search_v1 WHERE usage_monitoring_event_search_v1 MATCH 'ERA'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT value FROM settings WHERE key='fixture_saved_preference'").fetchone()[0], 'saved')
            self.assertEqual(db.execute("SELECT prompt_per_1m FROM model_prices WHERE model='fixture-model'").fetchone()[0], 0.123456789)
            self.assertEqual(db.execute('SELECT input_tokens,output_tokens,total_tokens FROM usage_events WHERE id=1').fetchone(), (410, 80, 490))
            self.assertEqual(json.loads(db.execute('SELECT raw_json FROM usage_events WHERE id=-3').fetchone()[0]),
                             {'cache_input_mode': 'separate_from_input', 'total_tokens': 700})
        for path in self.root.iterdir():
            if path.is_file():
                self.assertNotIn(SENTINEL.encode(), path.read_bytes(), path.name)
        reset.sanitize(self.path)
        self.assertEqual(self.fingerprint(), self.before)

    def test_native_manager_lock_and_sqlite_writer_exclude_reset(self):
        with Path(str(self.path) + '.manager.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'writer_still_running'):
                reset.sanitize(self.path)
        with sqlite3.connect(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError):
                reset.sanitize(self.path)
            db.rollback()
        self.assertEqual(self.fingerprint(), self.before)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT fail_body FROM usage_events WHERE id=1').fetchone()[0], SENTINEL)

    def test_interrupted_mutations_roll_back_and_retry_preserves_accounting(self):
        original = reset.scrub

        def fail_after_mutation(db, tables):
            original(db, tables)
            raise OSError('fixture interruption')

        with patch.object(reset, 'scrub', side_effect=fail_after_mutation):
            with self.assertRaisesRegex(OSError, 'fixture interruption'):
                reset.sanitize(self.path)
        self.assertEqual(self.fingerprint(), self.before)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM dead_letter_events').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT fail_body FROM usage_events WHERE id=1').fetchone()[0], SENTINEL)
        reset.sanitize(self.path)
        self.assertEqual(self.fingerprint(), self.before)

    def test_unknown_schema_and_symlinks_fail_before_mutation(self):
        link = self.root / 'linked.sqlite'; link.symlink_to(self.path)
        with self.assertRaisesRegex(ValueError, 'path_denied'):
            reset.sanitize(link)
        with sqlite3.connect(self.path) as db:
            db.execute('ALTER TABLE usage_events ADD COLUMN future_raw_content TEXT')
        with self.assertRaisesRegex(ValueError, 'schema_requires_review'):
            reset.sanitize(self.path)
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute('SELECT fail_body FROM usage_events WHERE id=1').fetchone()[0], SENTINEL)

    def test_retained_accounting_mismatch_rolls_back(self):
        original = reset.scrub

        def corrupt_accounting(db, tables):
            result = original(db, tables)
            db.execute('UPDATE usage_events SET total_tokens=total_tokens+1')
            return result

        with patch.object(reset, 'scrub', side_effect=corrupt_accounting):
            with self.assertRaisesRegex(RuntimeError, 'preservation_mismatch'):
                reset.sanitize(self.path)
        self.assertEqual(self.fingerprint(), self.before)

    def test_pinned_raw_hints_keep_alias_precedence_validity_and_nested_accounting(self):
        cases = [
            ('{"tokens":{"cache_input_mode":"included_in_input","total_tokens":123}}', {'cache_input_mode': 'included_in_input', 'total_tokens': 123}),
            ('{"usage":{"cacheInputMode":"separate_from_input","totalTokens":"456"}}', {'cache_input_mode': 'separate_from_input', 'total_tokens': 456}),
            ('{"detail":{"tokens":{"cache_input_mode":"included_in_input","total_tokens":789}}}', {'cache_input_mode': 'included_in_input', 'total_tokens': 789}),
            (json.dumps({'raw_json': json.dumps({'usage': {'total': 321, 'cacheInputMode': 'separate_from_input'}, 'private': SENTINEL})}), {'cache_input_mode': 'separate_from_input', 'total_tokens': 321}),
            ('{"cache_input_mode":"legacy","total_tokens":0}', {}),
            ('{"tokens":{"total_tokens":null,"totalTokens":900},"total_tokens":"10"}', {'total_tokens': 10}),
            ('{"cache_input_mode":null,"cacheInputMode":"included_in_input"}', {}),
            ('{"total_tokens":true}', {}),
            ('[]', None), ('null', None), ('invalid private data', None), ('{}', {}),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(reset.accounting_hints(raw), expected)
