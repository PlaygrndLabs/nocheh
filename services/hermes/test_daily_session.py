import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from . import daily_session
from .daily_session import choose, cursor_value, day_of, zone

BAKU=zone('Asia/Baku')
LOGICAL='a'*64


def at(text):
    """Unix seconds of a UTC time written as 'YYYY-MM-DD HH:MM'."""
    return datetime.strptime(text,'%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc).timestamp()


class DayRuleTests(unittest.TestCase):
    """A chat's session lasts one day, which turns at 04:00 in the chat's time zone."""

    def test_the_day_turns_at_four_in_the_chats_time_zone(self):
        # 03:59 and 04:00 in Baku (UTC+4).
        self.assertEqual(day_of(at('2026-11-24 23:59'),BAKU),'2026-11-24')
        self.assertEqual(day_of(at('2026-11-25 00:00'),BAKU),'2026-11-25')
        self.assertEqual(day_of(at('2026-11-25 03:59'),timezone.utc),'2026-11-24')

    def test_an_unknown_or_missing_time_zone_is_utc(self):
        for value in (None,'','Not/AZone',7,'x'*65):self.assertIs(zone(value),timezone.utc)

    def test_a_chats_first_session_keeps_its_fixed_id(self):
        self.assertEqual(choose(None,LOGICAL,at('2026-11-25 06:00'),BAKU),('nocheh-'+LOGICAL,None,'2026-11-25'))

    def test_the_same_day_continues_the_session(self):
        cursor={'session_id':'nocheh-x','day':'2026-11-25','last_active':at('2026-11-25 01:00')}
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 19:00'),BAKU),('nocheh-x',None,'2026-11-25'))

    def test_a_new_day_starts_a_session_named_by_its_day(self):
        cursor={'session_id':'nocheh-x','day':'2026-11-24','last_active':at('2026-11-24 18:00')}
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 05:00'),BAKU),('nocheh-'+LOGICAL+'-20261125','nocheh-x','2026-11-25'))

    def test_a_conversation_going_at_four_waits_for_half_an_hour_of_quiet(self):
        cursor={'session_id':'nocheh-x','day':'2026-11-24','last_active':at('2026-11-25 00:10')}
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 00:20'),BAKU)[1],None)
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 00:40'),BAKU)[1],'nocheh-x')

    def test_a_follow_up_after_an_approval_stays_in_the_session_that_asked(self):
        cursor={'session_id':'nocheh-x','day':'2026-11-24','last_active':at('2026-11-24 10:00')}
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 09:00'),BAKU,follow_up=True),('nocheh-x',None,'2026-11-24'))

    def test_a_cursor_from_before_daily_sessions_counts_as_todays(self):
        cursor=cursor_value({'session_id':'nocheh-x'})
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 09:00'),BAKU),('nocheh-x',None,'2026-11-25'))

    def test_a_retried_turn_lands_in_the_same_new_session(self):
        cursor={'session_id':'nocheh-x','day':'2026-11-24','last_active':at('2026-11-24 10:00')}
        self.assertEqual(choose(cursor,LOGICAL,at('2026-11-25 09:00'),BAKU),choose(cursor,LOGICAL,at('2026-11-25 09:05'),BAKU))

    def test_malformed_cursor_fields_read_as_none(self):
        self.assertIsNone(cursor_value({'day':'2026-11-24'}))
        self.assertEqual(cursor_value({'session_id':'s','day':5,'last_active':'x'}),{'session_id':'s','day':None,'last_active':None})

    def test_titles_carry_the_day(self):
        from .assistant_gateway import session_title
        self.assertEqual(session_title({'chat':{}},True,day='2026-11-25'),'Private chat · 25 Nov')
        self.assertEqual(session_title({'chat':{'title':'Team'}},False),'Team')
        self.assertEqual(session_title({'chat':{}},False,answer=True,day='2026-11-25'),'Private answer')


class NewDayTests(unittest.TestCase):
    """A new day's session starts with the last messages of the one before, which is closed but stays searchable."""

    def setUp(self):
        try:import persistence_assembly  # noqa: F401
        except ImportError:self.skipTest('pinned Hermes runtime required')
        self.folder=tempfile.TemporaryDirectory();self.profile=Path(self.folder.name)/'profile'
        self.profile.mkdir();(self.profile/'native-state').mkdir()
        from .native_store import writer
        from .store_fixture import add_message, add_session
        with writer(self.profile) as db:
            add_session(db,'old')
            for number in range(1,6):
                add_message(db,'old',role='user',content='question '+str(number))
                add_message(db,'old',role='assistant',content='',tool_calls=[{'id':'c'+str(number),'type':'function','function':{'name':'memory','arguments':'{}'}}])
                add_message(db,'old',role='tool',content='tool result',tool_call_id='c'+str(number),tool_name='memory')
                add_message(db,'old',role='assistant',content='answer '+str(number))

    def tearDown(self):
        self.folder.cleanup()

    def start(self,carry=4):
        from .native_store import writer
        with writer(self.profile) as db:daily_session.start(db,'new','old',carry)

    def read(self,session):
        from . import native_store
        with native_store.reader(self.profile) as db:
            return native_store.session_row(db,session),native_store.conversation(db,session)

    def test_the_new_session_starts_with_the_last_messages_only(self):
        self.start(4)
        row,messages=self.read('new')
        self.assertEqual([(m['role'],m['content']) for m in messages],
                         [('user','question 4'),('assistant','answer 4'),('user','question 5'),('assistant','answer 5')])
        self.assertEqual(row['parent_session_id'],'old')
        old,_=self.read('old')
        self.assertEqual(old['end_reason'],'daily')

    def test_carrying_none_starts_empty(self):
        self.start(0)
        self.assertEqual(self.read('new')[1],[])

    def test_starting_again_adds_nothing(self):
        self.start(4);self.start(4)
        self.assertEqual(len(self.read('new')[1]),4)

    def test_what_the_carried_messages_read_stays_with_the_new_session(self):
        """A carry drops tool results, so what they read is kept for "Do what I ask" (ADR-0293)."""
        from .isolated_profile import database_path
        from .native_store import writer
        from .note_sources import CARRIED_READS, conversation_reads
        from .store_fixture import add_message
        def reads():return conversation_reads(database_path(self.profile),'new',{},self.profile)
        with writer(self.profile) as db:daily_session.start(db,'new','old',4,profile=self.profile)
        self.assertEqual(reads(),[],'notes and typed questions read nothing outside')
        self.assertFalse((self.profile/CARRIED_READS).exists())
        with writer(self.profile) as db:
            add_message(db,'old',role='user',content='question 6')
            add_message(db,'old',role='assistant',content='',tool_calls=[{'id':'c6','type':'function','function':{'name':'mcp__nocheh__browser','arguments':'{}'}}])
            add_message(db,'old',role='tool',content='Step one: run this.',tool_call_id='c6',tool_name='mcp__nocheh__browser')
            add_message(db,'old',role='assistant',content='The page says to run this.')
        with writer(self.profile) as db:daily_session.start(db,'next','old',4,profile=self.profile)
        self.assertEqual(conversation_reads(database_path(self.profile),'next',{},self.profile),['web'],'the page read stays though its row is gone')
        # The next day's session carries on from that one, and so does what it read.
        with writer(self.profile) as db:daily_session.start(db,'after','next',4,profile=self.profile)
        self.assertEqual(conversation_reads(database_path(self.profile),'after',{},self.profile),['web'])
        (self.profile/CARRIED_READS).write_text('not a record')
        self.assertIsNone(reads(),'a record that cannot be read leaves the turn unreported')

    def test_session_search_still_finds_the_day_before(self):
        from persistence.conversation.sessions import BOUNDARY_END_REASONS
        self.assertIn(daily_session.END_REASON,BOUNDARY_END_REASONS)


class CarryKeepsTheDayTests(unittest.TestCase):
    """A new guard epoch keeps the session's day, so it never starts a new day's session early."""

    def setUp(self):
        try:import persistence_assembly  # noqa: F401
        except ImportError:self.skipTest('pinned Hermes runtime required')

    def test_carry_keeps_the_day(self):
        from .test_profile_history import ProfileHistoryTests
        case=ProfileHistoryTests();case.setUp()
        try:
            old=case.profile(5);case.converse(old)
            cursor=old/('active-'+'a'*64+'.json')
            cursor.write_text(json.dumps({'session_id':'nocheh-chat','day':'2026-11-24','last_active':1700000000}))
            new=case.profile(6)
            self.assertEqual(json.loads((new/cursor.name).read_text()),{'session_id':'nocheh-chat','day':'2026-11-24','last_active':1700000000})
        finally:case.tearDown()


if __name__=='__main__':
    unittest.main()
