"""Quiet hours (ADR-0297): which messages go without sound, and when."""
import unittest
from datetime import datetime, timezone

from services.telegram.quiet import QuietHours, inside, window


def at(hour, minute=0):
    return datetime(2026, 11, 24, hour, minute, tzinfo=timezone.utc)


class QuietHoursTests(unittest.TestCase):
    def test_window_reads_a_start_and_an_end_or_is_off(self):
        self.assertEqual(window('23:00-07:00'), (1380, 420))
        self.assertEqual(window('13:30-14:00'), (810, 840))
        for value in ('', '23:00', '24:00-07:00', '07:00-07:00', '7:00-8:00', 'off'):
            with self.subTest(value=value):
                self.assertIsNone(window(value))

    def test_a_window_past_midnight_wraps_on_the_persons_own_clock(self):
        span = window('23:00-07:00')
        self.assertTrue(inside(span, 'UTC', at(23, 30)))
        self.assertTrue(inside(span, 'UTC', at(6, 59)))
        self.assertFalse(inside(span, 'UTC', at(7)))
        self.assertFalse(inside(span, 'UTC', at(22, 59)))
        # 20:00 UTC is midnight in a zone four hours ahead.
        self.assertTrue(inside(span, 'Asia/Dubai', at(20)))
        self.assertFalse(inside(span, 'Asia/Dubai', at(4)))
        self.assertFalse(inside(span, 'Not/AZone', at(23, 30)))
        self.assertTrue(inside(window('01:00-02:00'), 'UTC', at(1, 30)))
        self.assertFalse(inside(window('01:00-02:00'), 'UTC', at(2)))

    def test_only_messages_nocheh_starts_go_silent_and_only_in_known_private_chats(self):
        reads = []
        def fetch():
            reads.append(1)
            return {'100': 'UTC', '200': 'Asia/Dubai'}
        clock = [0.0]
        quiet = QuietHours(fetch=fetch, clock=lambda: clock[0], setting='23:00-07:00')
        for kind in ('notice', 'card', 'job_report', 'approved_post', 'follow_up', None):
            with self.subTest(kind=kind):
                self.assertTrue(quiet.silent('100', kind, at(23, 30)))
        for kind in ('reminder', 'scheduled_run'):
            with self.subTest(kind=kind):
                self.assertFalse(quiet.silent('100', kind, at(23, 30)))
        self.assertFalse(quiet.silent('100', 'notice', at(12)))
        self.assertFalse(quiet.silent('200', 'notice', at(12)))
        self.assertTrue(quiet.silent('200', 'notice', at(20)))
        # A group or any chat core did not name keeps ringing.
        self.assertFalse(quiet.silent('-1001', 'notice', at(23, 30)))
        self.assertEqual(len(reads), 1, 'zones are read once a minute, not per message')
        clock[0] = 61.0
        quiet.silent('100', 'notice', at(23, 30))
        self.assertEqual(len(reads), 2)

    def test_off_or_unreadable_means_every_message_rings(self):
        self.assertFalse(QuietHours(fetch=lambda: {'100': 'UTC'}, setting='').silent('100', 'notice', at(23, 30)))
        def broken():
            raise OSError('core unreachable')
        self.assertFalse(QuietHours(fetch=broken, setting='23:00-07:00').silent('100', 'notice', at(23, 30)))
        # A failed read later keeps the zones read before.
        answers = iter([{'100': 'UTC'}])
        def flaky():
            return next(answers)
        clock = [0.0]
        quiet = QuietHours(fetch=flaky, clock=lambda: clock[0], setting='23:00-07:00')
        self.assertTrue(quiet.silent('100', 'notice', at(23, 30)))
        clock[0] = 120.0
        self.assertTrue(quiet.silent('100', 'notice', at(23, 30)))


    def test_the_setting_is_on_by_default_and_saved_only_as_a_window_or_empty(self):
        import tempfile
        from pathlib import Path
        from tools.operations.installation.configuration import initialize, load, validate
        with tempfile.TemporaryDirectory() as folder:
            initialize(Path(folder))
            values = load(Path(folder))
            self.assertEqual(values['NOCHEH_QUIET_HOURS'], '23:00-07:00')
            for good in ('', '22:30-06:15', '01:00-02:00'):
                with self.subTest(good=good):
                    validate({**values, 'NOCHEH_QUIET_HOURS': good})
            for bad in ('23:00', '07:00-07:00', '25:00-07:00', 'night'):
                with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'NOCHEH_QUIET_HOURS'):
                    validate({**values, 'NOCHEH_QUIET_HOURS': bad})


if __name__ == '__main__':
    unittest.main()
