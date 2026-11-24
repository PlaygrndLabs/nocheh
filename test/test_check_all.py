"""tools/development/check_all.py and the tester's end-of-run health check: failures are found and named exactly."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools.paths import ROOT
from tools.development import check_all, upstream_tests
from tools.acceptance import full_test


class CompareTests(unittest.TestCase):
    def test_only_unlisted_failures_are_new_and_listed_passes_are_shown(self):
        known = {'node': {'a.js :: one': {'reason': 'synthetic', 'since': '2026-11-24'},
                          'a.js :: two': {'reason': 'synthetic', 'since': '2026-11-24'}}}
        row = check_all.compare('node', {'ran': 3, 'failed': [{'test': 'a.js :: one', 'error': 'x'},
                                                              {'test': 'b.js :: three', 'error': 'y'}]}, known)
        self.assertEqual([item['test'] for item in row['new']], ['b.js :: three'])
        self.assertEqual([item['test'] for item in row['known']], ['a.js :: one'])
        self.assertEqual(row['fixed'], ['a.js :: two'])
        self.assertEqual(check_all.compare('python', {'ran': 1, 'failed': []}, known)['fixed'], [])
        flaky = {'python': {'t :: sometimes': {'reason': 'synthetic', 'since': '2026-11-24', 'flaky': True}}}
        self.assertEqual(check_all.compare('python', {'ran': 1, 'failed': []}, flaky)['fixed'], [])

    def test_the_known_failures_list_names_a_reason_for_each_entry(self):
        listed = json.loads(check_all.KNOWN.read_text())
        for section in check_all.SECTIONS + check_all.ON_REQUEST:
            for name, entry in listed[section].items():
                self.assertTrue(entry.get('reason') and entry.get('since'), name)


class UpstreamTests(unittest.TestCase):
    def test_imports_name_the_module_and_each_imported_member(self):
        names = upstream_tests.imported('import os\nfrom agent.store import (\n    Store, open_store as opened)\n'
                                         'from tools.base import thing\n    import gateway.run\n')
        self.assertTrue({'os', 'agent.store', 'agent.store.Store', 'agent.store.open_store', 'tools.base.thing',
                         'gateway.run'} <= names)

    def test_hermes_failures_name_the_test_and_files_failing_whole(self):
        text = ('[ 50.0% | 3/6 | ✓3 | ✗ 1] ✗ tests/a/test_one.py (2✓ 1✗, 1.0s)\n'
                '  ║ FAILED tests/a/test_one.py::test_bad - AssertionError: 1 != 2\n'
                '=== Summary: 3 files, 5 tests passed, 1 failed, 2 skipped; FAILED: 2 of 3 files (1 at import/collection) '
                '(100% complete) in 9.5s (4 workers) ===\n\n=== Failure output ===\n\n--- tests/a/test_one.py ---\n'
                'FAILED tests/a/test_one.py::test_bad - AssertionError: 1 != 2\n\n'
                '=== 1 file that FAILED AT IMPORT/COLLECTION (0 tests ran) ===\n  tests/b/test_two.py  ModuleNotFoundError\n'
                '=== 1 file with test failures ===\n  tests/a/test_one.py  (1 test failed)\n')
        ran, skipped, failed = upstream_tests.hermes_report(text)
        self.assertEqual((ran, skipped), (7, 2))
        self.assertEqual([(item['test'], item['error']) for item in failed],
                         [('hermes :: tests/a/test_one.py::test_bad', 'AssertionError: 1 != 2'),
                          ('hermes :: tests/b/test_two.py::(whole file)', 'that FAILED AT IMPORT/COLLECTION (0 tests ran)')])

    def test_a_hermes_run_that_did_not_finish_or_ran_nothing_fails(self):
        for text in ('Traceback\n', '=== Summary: 0 files, 0 tests passed, 0 failed (0% complete) in 0.1s (4 workers) ===\n'):
            self.assertEqual(upstream_tests.hermes_report(text)[2][0]['test'], 'hermes :: (whole suite)')

    def test_honcho_report_counts_skips_and_names_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / 'honcho.xml'
            self.assertEqual(upstream_tests.honcho_report(report)[2][0]['test'], 'honcho :: (whole suite)')
            report.write_text('<testsuites><testsuite><testcase classname="tests.x.test_a" name="test_ok"/>'
                              '<testcase classname="tests.x.test_a" name="test_skip"><skipped message="s"/></testcase>'
                              '<testcase classname="tests.x.test_a" name="test_bad"><failure message="boom&#10;more"/>'
                              '</testcase></testsuite></testsuites>')
            self.assertEqual(upstream_tests.honcho_report(report),
                             (2, 1, [{'test': 'honcho :: tests/x/test_a.py::test_bad', 'error': 'boom'}]))

    def test_upstream_runs_only_when_asked_for(self):
        self.assertNotIn('upstream', check_all.SECTIONS)
        self.assertIn('upstream', check_all.ON_REQUEST)


@unittest.skipUnless(shutil.which('node'), 'needs Node')
class ReporterTests(unittest.TestCase):
    def test_reporter_names_the_failed_subtest_with_its_parents(self):
        with tempfile.TemporaryDirectory() as folder:
            test = Path(folder) / 'sample.test.mjs'
            test.write_text("import {test} from 'node:test';\nimport assert from 'node:assert/strict';\n"
                            "test('fine', () => {});\n"
                            "test('outer', async t => { await t.test('inner', () => assert.equal(1, 2)); });\n")
            out = Path(folder) / 'failed.jsonl'
            subprocess.run(['node', '--test', '--test-reporter', str(check_all.REPORTER), '--test-reporter-destination', str(out),
                            str(test)], cwd=folder, capture_output=True)
            rows = [json.loads(line) for line in out.read_text().splitlines()]
        self.assertEqual([(row['file'], row['test']) for row in rows], [('sample.test.mjs', 'outer > inner')])
        self.assertIn('Expected values to be strictly equal', rows[0]['error'])


class UnittestReportTests(unittest.TestCase):
    def test_failed_tests_and_modules_that_do_not_import_are_listed(self):
        with tempfile.TemporaryDirectory() as folder:
            tests = Path(folder) / 'sample'
            tests.mkdir()
            (tests / 'test_good.py').write_text('import unittest\nclass T(unittest.TestCase):\n'
                                                '    def test_ok(self): pass\n    def test_bad(self): self.assertEqual(1, 2)\n')
            (tests / 'test_broken.py').write_text('import not_a_module_anywhere\n')
            out = Path(folder) / 'result.json'
            subprocess.run([sys.executable, '-m', 'tools.development.unittest_report', '--out', str(out), '--start', str(tests),
                            '--top', str(tests)], cwd=ROOT, capture_output=True, env={**os.environ, 'PYTHONPATH': str(ROOT)})
            result = json.loads(out.read_text())
        self.assertEqual(result['ran'], 3)
        self.assertEqual(sorted(item['test'] for item in result['failed']), ['import test_broken', 'test_good.T.test_bad'])


class HealthTests(unittest.TestCase):
    def test_signals_match_the_lines_they_name(self):
        lines = {'missing table or column': 'ERROR:  relation "learned_conventions" does not exist at character 15',
                 'deadlock': 'ERROR:  deadlock detected', 'Python traceback': 'Traceback (most recent call last):',
                 'unhandled Node error': '[UnhandledPromiseRejection: This error originated either by throwing]'}
        for name, line in lines.items():
            self.assertEqual([key for key, pattern in full_test.LOG_SIGNALS.items() if pattern.search(line)], [name])
        self.assertFalse(any(pattern.search('reply sent in 2.1 s') for pattern in full_test.LOG_SIGNALS.values()))

    def test_report_names_every_finding(self):
        row = {'scenario': 'end_of_run_health', 'passed': False, 'observed': {
            'unhealthy_containers': ['hermes restarted 4 times'],
            'log_signals': {'Python traceback': {'hermes': {'count': 2, 'examples': ['Traceback (most recent call last):']}}},
            'leftover_work': ['memory_review running: 1'], 'honcho_learning_queue': ['representation: 0 waiting, 3 failed']}}
        text = '\n'.join(full_test.health_lines(row))
        for part in ('hermes restarted 4 times', 'Python traceback: hermes 2', 'memory_review running: 1', '3 failed'):
            self.assertIn(part, text)


if __name__ == '__main__':
    unittest.main()
