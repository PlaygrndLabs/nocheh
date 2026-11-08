"""The owner's problem notices: new or worse problems reach Telegram once, without spam."""
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

from tools.operations.provider import problems

NOW = datetime(2026, 10, 28, 12, tzinfo=timezone.utc).timestamp()
TODAY = '2026-10-28'


def monitoring(failed=11, uncertain=0, services=(), work=True, retryable=0):
    counts = [{'family': 'memory_review', 'state': 'failed', 'count': failed},
              {'family': 'telegram', 'state': 'retryable_failed', 'count': retryable},
              {'family': 'memory_review', 'state': 'completed', 'count': 500},
              {'family': 'telegram', 'state': 'ambiguous', 'count': uncertain}]
    # Like the database's GROUP BY, a state with no tasks has no row.
    counts = [row for row in counts if row['count']]
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
        self.edits = []
        self.edit_outcome = 'done'

    def check(self, now, state=None, usage=(), enabled=True, outcome=None, values=None):
        def send(body):
            if body.get('edit'):
                self.edits.append(body)
                return {'state': self.edit_outcome}
            self.sent.append(body)
            return {'state': outcome or self.outcome}
        return problems.check(self.state, state or monitoring(), None if usage is None else list(usage), send, now, enabled, values or {})

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
        self.assertEqual(self.sent[-1]['problems'], ['Secret check (synthetic-model): 1 model call failed today: 1 refused by the model.'])
        self.check(NOW + 600, usage=refusals(4, 3, hidden=1))
        self.assertEqual(len(self.sent), 1, 'worse, but within the quiet hour')
        self.check(NOW + 3700, usage=refusals(4, 3, hidden=1))
        self.assertEqual(self.sent[-1]['problems'], [
            'Secret check (synthetic-model): 4 model calls failed today: 3 refused by the model, 1 reason not known; '
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

    def test_open_goes_to_the_mini_app_or_the_dashboard_and_retry_shows_for_retryable_tasks(self):
        self.check(NOW)
        with patch.dict('os.environ', {'NOCHEH_DASHBOARD_PORT': '8783'}):
            self.check(NOW + 120, monitoring(failed=12))
        self.assertEqual((self.sent[-1]['open'], self.sent[-1]['retry']), ({'kind': 'url', 'url': 'http://127.0.0.1:8783/#system'}, False),
                         'closed failures cannot be retried, and without a mini app Open goes to this computer’s dashboard')
        self.check(NOW + 240, monitoring(failed=12, retryable=2), values={'NOCHEH_DASHBOARD_URL': 'https://dash.example.test/'})
        self.assertEqual((self.sent[-1]['open'], self.sent[-1]['retry']), ({'kind': 'url', 'url': 'https://dash.example.test/#system'}, True))
        mini = {'TELEGRAM_ENABLED': 'true', 'NOCHEH_MINI_APP_URL': 'https://mini.example.test', 'CLOUDFLARE_TUNNEL_TOKEN': 'x' * 40}
        self.assertEqual(problems.opening(mini), {'kind': 'web_app', 'url': 'https://mini.example.test/?page=problems'})

    def test_a_notice_says_why_model_calls_failed(self):
        row = {**refusals(4, 1)[0], 'part': 'memory_review', 'label': 'Memory notes',
               'reasons': {'timed_out': 2, 'refused': 1, 'provider_error': 1}}
        self.check(NOW, usage=[row])
        self.assertEqual(self.sent[-1]['problems'], [
            'Memory notes (synthetic-model): 4 model calls failed today: 2 took too long, 1 refused by the model, '
            '1 the provider had an error.'])
        found = problems.problems(monitoring(), [{**row, 'reasons': {'unknown': 4}, 'refused': 0}], TODAY)
        self.assertEqual(problems.text(next(p for p in found if p['kind'] == 'model'), 4),
                         'Memory notes (synthetic-model): 4 model calls failed today.', 'no reason known, none said')

    def test_a_notice_says_the_providers_exact_error_where_it_is_known(self):
        row = {**refusals(5, 0)[0], 'part': 'memory_review', 'label': 'Memory notes',
               'reasons': {'provider_error': 4, 'timed_out': 1},
               'causes': {'provider_error:overloaded:529': 2, 'provider_error:thinking_signature:400': 1,
                          'timed_out:timeout': 1, 'refused:content_policy_blocked': 3, 'provider_error:Private words': 1}}
        self.check(NOW, usage=[row])
        self.assertEqual(self.sent[-1]['problems'], [
            'Memory notes (synthetic-model): 5 model calls failed today: 2 the provider was overloaded (HTTP 529), '
            '1 took too long, 1 the provider had an error (thinking signature, HTTP 400), 1 the provider had an error.'],
            'a cause of a reason with no failures, or one that is not a code, is left out')
        stopped = {**refusals(3, 0)[0], 'reasons': {'provider_error': 1, 'unknown': 2},
                   'causes': {'provider_error:loop_error': 1, 'unknown:repeated_outer_errors': 2}}
        self.assertEqual(problems.why(stopped), '2 the assistant stopped after repeated errors, 1 the assistant stopped the run after errors',
                         'a run the assistant stopped itself is not called a provider error')
        dropped = {**refusals(12, 0)[0], 'reasons': {'unknown': 12}, 'causes': {'unknown:connection': 12}}
        self.assertEqual(problems.why(dropped), '12 couldn’t reach the provider or lost the connection',
                         'a cause says why even when the reason alone is not known')

    def test_only_todays_model_failures_count(self):
        found = problems.problems(monitoring(), refusals(1, 1), TODAY)
        self.assertEqual({problem['kind'] for problem in found}, {'failed', 'model'})
        yesterday = problems.problems(monitoring(), [{**refusals(1, 1)[0], 'day': '2026-10-27'}], TODAY)
        self.assertEqual([problem for problem in yesterday if problem['kind'] == 'model'], [],
                         'yesterday’s failures are not today’s')

    def test_a_notice_line_is_marked_when_its_model_works_again(self):
        def busy(failed, runs):
            return [{**refusals(failed, 0)[0], 'part': 'memory_review', 'label': 'Memory notes', 'runs': runs,
                     'reasons': {'provider_error': failed}, 'causes': {'provider_error:overloaded:529': failed}}]
        self.check(NOW, usage=busy(1, 10))
        line = 'Memory notes (synthetic-model): 1 model call failed today: 1 the provider was overloaded (HTTP 529).'
        self.assertEqual(self.sent[-1]['problems'], [line])
        self.check(NOW + 120, usage=busy(1, 10))
        self.assertEqual(self.edits, [], 'nothing has worked since')
        self.check(NOW + 240, usage=busy(2, 12))
        self.assertEqual(self.edits, [], 'it failed again, and a call that worked may have come before that failure')
        self.check(NOW + 900, usage=busy(2, 13))
        self.assertEqual(self.edits, [{'id': self.sent[0]['id'], 'problems': [line + ' Worked again at 12:15 UTC.'], 'resolved': [True],
                                       'open': None, 'retry': False, 'edit': True}], 'marked in place and without buttons')
        self.check(NOW + 1020, usage=busy(2, 14))
        self.assertEqual((len(self.edits), len(self.sent)), (1, 1))
        # It fails again within the quiet hour, so no new notice: the ✅ is taken back instead, buttons and all.
        self.check(NOW + 1140, usage=busy(3, 15))
        self.assertEqual((self.edits[-1]['problems'], self.edits[-1]['resolved'], len(self.sent)), ([line], [False], 1))
        self.assertIsNotNone(self.edits[-1]['open'])
        self.check(NOW + 1260, usage=busy(3, 16))
        self.assertEqual(self.edits[-1]['problems'], [line + ' Worked again at 12:21 UTC.'])
        self.check(NOW + 3800, usage=busy(3, 17))
        self.assertEqual(len(self.edits), 3)
        self.assertNotIn(self.sent[0]['id'], [notice['id'] for notice in problems._read(self.state)['notices']],
                         'once its quiet hour is over, a cleared notice is no longer followed')

    def test_retried_tasks_clear_their_line_and_the_notice_loses_its_buttons_when_all_clear(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(failed=12, retryable=2))
        lines = ['Memory notes: 1 task failed (12 so far).', 'Telegram replies: 2 tasks failed (2 so far).']
        self.assertEqual((self.sent[-1]['problems'], self.sent[-1]['retry']), (lines, True))
        self.check(NOW + 240, monitoring(failed=12))
        self.assertEqual(self.edits, [], 'a drop seen by one check may be a task being retried')
        self.check(NOW + 360, monitoring(failed=12))
        dashboard = {'kind': 'url', 'url': 'http://127.0.0.1:8783/#system'}
        self.assertEqual({key: self.edits[-1][key] for key in ('problems', 'resolved', 'open', 'retry')},
                         {'problems': [lines[0], lines[1] + ' Resolved at 12:06 UTC.'], 'resolved': [False, True], 'open': dashboard, 'retry': False},
                         'Open stays for what is left; Retry failed goes with the tasks it could retry')
        self.check(NOW + 480, monitoring(failed=11, work=False))
        self.check(NOW + 600, monitoring(failed=11, work=False))
        self.assertEqual(len(self.edits), 1, 'unreadable background work clears nothing')
        self.check(NOW + 720, monitoring(failed=11))
        self.check(NOW + 840, monitoring(failed=11))
        self.assertEqual((self.edits[-1]['resolved'], self.edits[-1]['open']), ([True, True], None))
        self.assertEqual(self.edits[-1]['problems'][0], lines[0] + ' Resolved at 12:14 UTC.')

    def test_a_family_retried_to_zero_counts_its_next_failures_from_zero(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(retryable=3))
        self.check(NOW + 240, monitoring())
        self.check(NOW + 360, monitoring())
        self.assertEqual(self.edits[-1]['resolved'], [True], 'all 3 retried and done')
        self.check(NOW + 7200, monitoring(retryable=5))
        self.assertEqual(self.sent[-1]['problems'], ['Telegram replies: 5 tasks failed (5 so far).'])
        self.assertEqual(len(self.edits), 1, 'the first notice’s ✅ stays: the new failures have a notice of their own')
        self.check(NOW + 7320, monitoring(retryable=3))
        self.assertEqual(len(self.edits), 1, '3 still failed: the newer notice stays open')

    def test_a_problem_back_within_the_quiet_hour_takes_back_its_check_mark(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(failed=12, retryable=1))
        lines = self.sent[-1]['problems']
        self.check(NOW + 240, monitoring(failed=12))
        self.check(NOW + 300, monitoring(failed=12))
        self.assertEqual((self.edits[-1]['resolved'], self.edits[-1]['retry']), ([False, True], False), 'Retry failed ran it, and it was done')
        self.check(NOW + 360, monitoring(failed=12, retryable=1))
        self.assertEqual((self.edits[-1]['problems'], self.edits[-1]['resolved'], self.edits[-1]['retry']), (lines, [False, False], True),
                         'it failed again: the line and Retry failed are back')
        self.assertEqual(len(self.sent), 1, 'no new notice within the quiet hour')
        # A down service needs two checks to be news, and to take back its ✅.
        self.check(NOW + 480, monitoring(failed=12, services=['hermes']))
        self.check(NOW + 600, monitoring(failed=12, services=['hermes']))
        service = self.sent[-1]
        self.check(NOW + 720, monitoring(failed=12))
        self.assertEqual(self.edits[-1]['id'], service['id'])
        self.assertEqual(self.edits[-1]['resolved'], [True])
        edits = len(self.edits)
        self.check(NOW + 840, monitoring(failed=12, services=['hermes']))
        self.assertEqual(len(self.edits), edits, 'one check is a restart, not news')
        self.check(NOW + 960, monitoring(failed=12, services=['hermes']))
        self.assertEqual((self.edits[-1]['id'], self.edits[-1]['resolved']), (service['id'], [False]))

    def test_a_task_that_keeps_failing_and_is_retried_is_not_news_again(self):
        self.check(NOW)
        self.check(NOW + 120, monitoring(retryable=1))
        # Every few minutes the scheduler retries it: while it runs, it is not counted as failed.
        for step in range(2, 40):
            self.check(NOW + 120 * step, monitoring(retryable=0 if step % 4 == 0 else 1))
        self.assertEqual((len(self.sent), self.edits), (1, []), 'one notice, and no ✅ while it keeps failing')

    def test_a_problem_missing_because_its_source_could_not_be_read_is_not_news_again(self):
        self.check(NOW, monitoring(services=['hermes']))
        self.check(NOW + 120, monitoring(services=['hermes']))
        self.check(NOW + 3700, {**monitoring(), 'services': None})
        self.check(NOW + 3820, monitoring(services=['hermes']))
        self.check(NOW + 3940, monitoring(services=['hermes']))
        self.assertEqual(len(self.sent), 1, 'still the same down service')
        busy = refusals(2, 2)
        self.check(NOW + 4000, {**monitoring(), 'model_problems': busy}, usage=None)
        self.check(NOW + 7700, {**monitoring(), 'model_problems': {'unavailable': True}}, usage=None)
        self.check(NOW + 7820, {**monitoring(), 'model_problems': busy}, usage=None)
        self.assertEqual(len(self.sent), 2, 'the same failed model calls, after a check that could not read usage')

    def test_an_edit_that_does_not_go_through_is_tried_again(self):
        self.check(NOW, monitoring(services=['hermes']))
        self.check(NOW + 120, monitoring(services=['hermes']))
        self.check(NOW + 240, {**monitoring(), 'services': None})
        self.assertEqual(self.edits, [], 'services that could not be read clear nothing')
        self.edit_outcome = 'not_started'
        self.check(NOW + 360, monitoring())
        self.check(NOW + 480, monitoring())
        self.assertEqual([edit['problems'] for edit in self.edits], [['Assistant isn’t running as expected. Resolved at 12:06 UTC.']] * 2)
        self.edit_outcome = 'done'
        self.check(NOW + 600, monitoring())
        self.check(NOW + 720, monitoring())
        self.assertEqual(len(self.edits), 3)
        self.assertEqual(len(self.sent), 1)

    def test_a_telegram_outage_clears_once_telegram_is_connected(self):
        down = {**monitoring(), 'telegram_incident': {'at': '2026-10-28T11:50:00+00:00', 'error_code': 'telegram_network_error'}}
        self.check(NOW, down)
        self.assertEqual(self.sent[-1]['problems'], ['Telegram stopped working at 2026-10-28 11:50 UTC: it couldn’t reach Telegram.'])
        self.check(NOW + 120, {**down, 'runtime': {'status': {'telegram': 'recovering'}}})
        self.assertEqual(self.edits, [])
        self.edit_outcome = 'not_found'
        self.check(NOW + 240, {**down, 'runtime': {'status': {'telegram': 'connected'}}})
        self.check(NOW + 360, {**down, 'runtime': {'status': {'telegram': 'connected'}}})
        self.assertEqual([edit['resolved'] for edit in self.edits], [[True]], 'a notice with no message to edit is no longer followed')

    def test_a_refused_github_app_gives_one_notice(self):
        refused = {**monitoring(), 'github': {'connected': False, 'reconnect': True}}
        self.check(NOW)
        self.check(NOW + 120, refused)
        self.assertEqual(self.sent[-1]['problems'],
                         ['GitHub refused Nocheh’s app. Jobs keep the copies they have; connect GitHub again in Settings › Connections.'])
        self.check(NOW + 4000, refused)
        self.assertEqual(len(self.sent), 1, 'one notice for one refused app')
        connected = {'connected': True, 'reconnect': False}
        self.assertEqual([p for p in problems.problems({**monitoring(), 'github': connected}, [], TODAY) if p['kind'] == 'github'], [],
                         'a connected app gives no notice: its key never expires')


if __name__ == '__main__':
    unittest.main()
