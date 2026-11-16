"""The tester's waits behind the owner's notes reviews (tools/acceptance/product_scenarios.py) wait as long as the review
backlog can take, stop at once when the awaited review ended without a note, and keep their timeout label when the
backlog count can't be read."""
import ast
import contextlib
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.acceptance.product_scenarios import ProductScenarios
from tools.acceptance.telegram_scenarios import Failed
from tools.paths import ROOT

EVENT = 'e1'*32


class Clock:
    """time.monotonic and time.sleep for a wait that takes no real time."""
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Store:
    """The fixture's query(): `answers` maps a piece of SQL to its answer (a function of the clock, or an exception)."""
    def __init__(self, clock, answers):
        self.clock, self.answers, self.asked = clock, answers, []

    def query(self, database, sql):
        for part, answer in self.answers.items():
            if part in sql:
                self.asked.append(part)
                if isinstance(answer, Exception):
                    raise answer
                return answer(self.clock.now) if callable(answer) else answer
        raise AssertionError('unexpected query: '+sql)


ENDED, PENDING, SETTLED = "THEN 'paused'", "WHERE state='pending'", "state IN ('queued','running','waiting','retryable_failed')"


class ReviewWaitTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        for name in ('monotonic', 'sleep'):
            patcher = patch('time.'+name, getattr(self.clock, name))
            patcher.start()
            self.addCleanup(patcher.stop)

    def scenarios(self, answers):
        store = Store(self.clock, answers)
        found = ProductScenarios(store, Path(self.folder.name))
        found.current = {'scenario': 'synthetic', 'gates': []}
        return found, store

    def wait(self, scenarios, *args, **options):
        with contextlib.redirect_stdout(io.StringIO()):
            return scenarios.review_wait(*args, **options)

    def test_a_review_that_ended_without_a_note_fails_at_once_with_its_state(self):
        for state in ('ambiguous', 'paused'):
            with self.subTest(state=state):
                scenarios, _ = self.scenarios({ENDED: state})
                started = self.clock.now
                with self.assertRaises(Failed) as raised:
                    self.wait(scenarios, 'review_done', lambda: None, event_id=EVENT)
                self.assertEqual(str(raised.exception), 'review_'+state+':review_done')
                self.assertEqual(self.clock.now, started)

    def test_a_review_still_waiting_is_waited_for_and_looked_at_only_now_and_then(self):
        scenarios, store = self.scenarios({ENDED: '', PENDING: '41'})
        with self.assertRaises(Failed) as raised:
            self.wait(scenarios, 'review_done', lambda: None, event_id=EVENT)
        self.assertEqual(str(raised.exception), 'timeout:review_done:reviews_pending=41')
        self.assertGreaterEqual(self.clock.now, ProductScenarios.REVIEW_SECONDS)
        looks = store.asked.count(ENDED)
        self.assertLessEqual(looks, ProductScenarios.REVIEW_SECONDS//ProductScenarios.REVIEW_ENDED_EVERY+1)
        self.assertGreater(looks, 1)

    def test_a_review_that_ends_later_stops_the_wait_then(self):
        scenarios, _ = self.scenarios({ENDED: lambda now: 'ambiguous' if now >= 300 else ''})
        with self.assertRaisesRegex(Failed, '^review_ambiguous:review_saved_the_note$'):
            self.wait(scenarios, 'review_saved_the_note', lambda: [], 10, EVENT)
        self.assertLess(self.clock.now, 300+ProductScenarios.REVIEW_ENDED_EVERY+10)

    def test_a_state_that_cannot_be_read_keeps_waiting(self):
        broken = subprocess.CalledProcessError(1, ['psql'])
        scenarios, _ = self.scenarios({ENDED: broken})
        self.assertEqual(self.wait(scenarios, 'review_done', lambda: self.clock.now >= 900 and 'done', event_id=EVENT), 'done')

    def test_a_backlog_count_that_cannot_be_read_keeps_the_timeout_label(self):
        scenarios, _ = self.scenarios({PENDING: subprocess.CalledProcessError(1, ['psql'])})
        with self.assertRaises(Failed) as raised:
            self.wait(scenarios, 'learning_settled', lambda: False)
        self.assertEqual(str(raised.exception), 'timeout:learning_settled:reviews_pending=unknown')

    def test_a_step_that_is_done_needs_no_look_at_the_review(self):
        scenarios, store = self.scenarios({})
        self.assertEqual(self.wait(scenarios, 'review_done', lambda: {'state': 'done'}, event_id=EVENT), {'state': 'done'})
        self.assertEqual(store.asked, [])

    def test_a_message_not_learned_may_wait_behind_the_review_backlog(self):
        # Its notes review step and long-term memory step take the background slot the reviews hold.
        scenarios, _ = self.scenarios({SETTLED: lambda now: '1' if now < 1800 else '0', "AND family='memory_review'": '1',
                                       'string_agg': 'honcho:skipped:nocheh_message,memory_review:skipped:nocheh_message'})
        with contextlib.redirect_stdout(io.StringIO()):
            outcome = scenarios.learning(EVENT)
        self.assertEqual(outcome, ['honcho:skipped:nocheh_message', 'memory_review:skipped:nocheh_message'])
        self.assertGreaterEqual(self.clock.now, 1800)


class ReviewBacklogWaitsTests(unittest.TestCase):
    # Each of these waits for a step that takes the background slot the owner's notes reviews hold.
    BEHIND_REVIEWS = {'learning_settled', 'own_message_reviewed', 'kept_out_of_the_owners_notes', 'review_saved_the_note', 'review_done',
                      'reply_reviewed', 'off_reviews_settled', 'private_reviews_settled', 'again_reviews_settled'}

    def test_every_wait_behind_the_reviews_is_a_review_wait(self):
        tree = ast.parse((ROOT/'tools/acceptance/product_scenarios.py').read_text())
        labels = {'wait': set(), 'review_wait': set()}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in labels and node.args \
                    and isinstance(node.args[0], ast.Constant):
                labels[node.func.attr].add(node.args[0].value)
        self.assertEqual(self.BEHIND_REVIEWS-labels['review_wait'], set())
        self.assertEqual(self.BEHIND_REVIEWS & labels['wait'], set())


if __name__ == '__main__':
    unittest.main()
