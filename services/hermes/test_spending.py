import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from tools.operations.provider import spending

NOW = datetime(2026, 3, 20, 12, tzinfo=timezone.utc).timestamp()
VALUES = {'NOCHEH_MONTHLY_LIMIT_USD': '50'}


def rows(*costs, day='2026-03-05'):
    return [{'day': day, 'part': 'reply', 'runs': 1, 'cost_usd': cost} for cost in costs]


class Spending(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.state = Path(self.root.name)
        self.sent, self.paused = [], []

    def tearDown(self):
        self.root.cleanup()

    def check(self, found, values=VALUES, now=NOW, outcome='done'):
        def send(body):
            self.sent.append(body)
            return {'state': outcome}
        return spending.check(self.state, values=values, now=now, rows=found, send=send, pause=self.paused.append)

    def test_off_until_the_owner_sets_an_amount(self):
        result = self.check(rows(500), values={'NOCHEH_MONTHLY_LIMIT_USD': ''})
        self.assertEqual((result['state'], self.sent, self.paused), ('off', [], []))

    def test_warns_once_at_80_percent_and_pauses_at_the_limit(self):
        self.check(rows(30))
        self.assertEqual((self.sent, self.paused), ([], []))
        self.check(rows(30, 11))
        self.assertEqual(len(self.sent), 1)
        self.assertIn('$41.00 of your monthly spending limit of $50.00 (82%)', self.sent[0]['problems'][0])
        self.check(rows(30, 12))
        self.assertEqual((len(self.sent), self.paused), (1, []))
        result = self.check(rows(30, 21))
        self.assertEqual((result['level'], self.paused), (100, ['2026-03']))
        self.assertIn('reached your monthly spending limit', self.sent[-1]['problems'][0])
        self.check(rows(30, 22))
        self.assertEqual((len(self.sent), self.paused), (2, ['2026-03']))

    def test_raising_the_limit_or_a_new_month_resumes(self):
        self.check(rows(60))
        self.check(rows(60), values={'NOCHEH_MONTHLY_LIMIT_USD': '100'})
        self.assertEqual(self.paused, ['2026-03', None])
        self.check(rows(60))
        april = datetime(2026, 4, 1, 0, 5, tzinfo=timezone.utc).timestamp()
        self.check(rows(60), now=april)
        self.assertEqual(self.paused, ['2026-03', None, '2026-03', None])

    def test_turning_the_limit_off_resumes(self):
        self.check(rows(60))
        self.check(rows(60), values={})
        self.assertEqual(self.paused, ['2026-03', None])

    def test_unpriced_costs_are_named_and_a_failed_send_is_tried_again(self):
        found = rows(45) + [{'day': '2026-03-06', 'part': 'memory', 'runs': 3, 'cost_usd': None}]
        self.check(found, outcome='not_started')
        self.check(found)
        self.assertEqual(len(self.sent), 2)
        self.assertIn('could not be priced (1)', self.sent[-1]['problems'][0])
        self.check(found)
        self.assertEqual(len(self.sent), 2)

    def test_a_failed_pause_is_tried_again(self):
        def broken(_):
            raise OSError()
        spending.check(self.state, values=VALUES, now=NOW, rows=rows(60), send=lambda body: {'state': 'done'}, pause=broken)
        self.assertNotIn('paused', json.loads((self.state / spending.RECORD).read_text()))
        self.check(rows(60))
        self.assertEqual(self.paused, ['2026-03'])

    def test_only_this_month_counts(self):
        self.check(rows(60, day='2026-02-28') + rows(5))
        self.assertEqual((self.sent, self.paused), ([], []))

    def test_summary_shows_this_and_last_month(self):
        view = lambda state, days, now=None: {'rows': rows(3) + rows(7, day='2026-02-10') + [
            {'day': '2026-02-11', 'part': 'memory', 'runs': 1, 'cost_usd': None}]}
        found = spending.summary(self.state, now=NOW, view=view)
        self.assertEqual((found['spent_usd'], found['last_month'], found['last_month_usd'], found['last_month_unpriced']),
                         (3, '2026-02', 7, 1))

    def test_the_setting_takes_whole_dollars_or_empty(self):
        from tools.operations.installation.configuration import DEFAULTS, initialize, load, validate
        self.assertEqual(DEFAULTS['NOCHEH_MONTHLY_LIMIT_USD'], '')
        initialize(self.state / 'install')
        values = load(self.state / 'install')
        for good in ('', '1', '250', '100000'):
            validate({**values, 'NOCHEH_MONTHLY_LIMIT_USD': good})
        for bad in ('0', '12.5', '100001', '-3', 'ten'):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'NOCHEH_MONTHLY_LIMIT_USD'):
                validate({**values, 'NOCHEH_MONTHLY_LIMIT_USD': bad})


if __name__ == '__main__':
    unittest.main()
