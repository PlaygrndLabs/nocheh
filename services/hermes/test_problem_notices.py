"""The owner's problem notices: new or worse problems reach Telegram once, without spam."""
import tempfile
import unittest
from datetime import datetime, timezone

from tools.operations.provider import problems

NOW = datetime(2026, 10, 28, 12, tzinfo=timezone.utc).timestamp()
TODAY = '2026-10-28'


def monitoring(failed=11, uncertain=0, services=(), work=True):
    counts = [{'family': 'memory_review', 'state': 'failed', 'count': failed},
              {'family': 'memory_review', 'state': 'completed', 'count': 500}]
    if uncertain:
        counts.append({'family': 'telegram', 'state': 'ambiguous', 'count': uncertain})
    return {'application': {'ok': True}, 'services': [{'service': name, 'tool': 'Assistant', 'state': 'unhealthy'} for name in services],
            'routes': [{'part': 'reply', 'label': 'Replies', 'configured': True}],
            'workflows': {'counts': counts, 'workers': []} if work else {'unavailable': True}}


def refusals(failed, refused, hidden=0):
    return [{'day': TODAY, 'part': 'guard', 'label': 'Secret check', 'provider': 'anthropic', 'model': 'synthetic-model',
             'failed': failed, 'refused': refused, 'hidden': hidden}]


class ProblemNoticeTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.state = folder.name
        self.sent = []
        self.outcome = 'done'

    def check(self, now, state=None, usage=(), enabled=True, outcome=None):
        def send(body):
            self.sent.append(body)
            return {'state': outcome or self.outcome}
        return problems.check(self.state, state or monitoring(), list(usage), send, now, enabled)

    def test_old_failures_are_not_announced_and_new_ones_are_counted_from_them(self):
        self.assertEqual(self.check(NOW)['state'], 'nothing_new')
        self.assertEqual(self.sent, [], 'failures already in the history stay quiet')
        self.check(NOW + 120, monitoring(failed=13, uncertain=1))
        self.assertEqual(self.sent[-1]['problems'], [
            'Memory notes: 2 tasks failed (13 so far).',
            'Telegram replies: 1 task ended with an uncertain result (1 so far). Nocheh doesn’t repeat these automatically.'])
        self.check(NOW + 240, monitoring(failed=13, uncertain=1))
        self.assertEqual(len(self.sent), 1, 'nothing new')

    def test_refusals_repeat_at_most_once_an_hour_and_only_when_worse(self):
        self.check(NOW, usage=refusals(1, 1))
        self.assertEqual(self.sent[-1]['problems'], ['Secret check (synthetic-model): 1 model call failed today, 1 refused by the model.'])
        self.check(NOW + 600, usage=refusals(4, 3, hidden=1))
        self.assertEqual(len(self.sent), 1, 'worse, but within the quiet hour')
        self.check(NOW + 3700, usage=refusals(4, 3, hidden=1))
        self.assertEqual(self.sent[-1]['problems'], [
            'Secret check (synthetic-model): 4 model calls failed today, 3 refused by the model; '
            '1 text was hidden whole because the model refused to check it.'])
        self.check(NOW + 8000, usage=refusals(4, 3, hidden=1))
        self.assertEqual(len(self.sent), 2, 'not worse, so not repeated')

    def test_a_down_service_is_reported_only_when_two_checks_see_it(self):
        self.check(NOW, monitoring(services=['hermes']))
        self.check(NOW + 120, monitoring())
        self.assertEqual(self.sent, [], 'a restart is not news')
        self.check(NOW + 240, monitoring(services=['hermes']))
        self.check(NOW + 360, monitoring(services=['hermes']))
        self.assertEqual(self.sent[-1]['problems'], ['Assistant isn’t running as expected.'])

    def test_an_unsent_notice_is_tried_again_with_the_same_id(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(failed=12), outcome='not_started')
        self.check(NOW + 240, monitoring(failed=12))
        self.assertEqual([body['id'] for body in self.sent], [self.sent[0]['id']] * 2)
        self.check(NOW + 360, monitoring(failed=12))
        self.assertEqual(len(self.sent), 2, 'sent once it went through')
        self.check(NOW + 4000, monitoring(failed=13))
        self.assertNotEqual(self.sent[-1]['id'], self.sent[0]['id'])

    def test_turned_off_sends_nothing_and_turning_on_does_not_replay_it(self):
        self.check(NOW)
        self.assertEqual(self.check(NOW + 120, monitoring(failed=20), usage=refusals(2, 2), enabled=False)['state'], 'turned_off')
        self.check(NOW + 4000, monitoring(failed=20), usage=refusals(2, 2))
        self.assertEqual(self.sent, [])

    def test_unreadable_background_work_does_not_reset_its_totals(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(work=False))
        self.check(NOW + 240, monitoring(work=False))
        self.assertEqual(self.sent[-1]['problems'], ['Background work couldn’t be checked.'])
        self.check(NOW + 360, monitoring(failed=11))
        self.assertEqual(len(self.sent), 1, 'the old failures are not news once it can be read again')

    def test_only_todays_model_failures_count(self):
        found = problems.problems(monitoring(), refusals(1, 1), TODAY)
        self.assertEqual({problem['kind'] for problem in found}, {'failed', 'model'})
        self.assertEqual(problems.problems(monitoring(), [{**refusals(1, 1)[0], 'day': '2026-10-27'}], TODAY)[1:], [],
                         'yesterday’s failures are not today’s')


if __name__ == '__main__':
    unittest.main()
