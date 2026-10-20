import json
import tempfile
import unittest
from pathlib import Path

from .test_retired_history import FACT, Lookup, PRIVATE, UNRELATED, call, marker

GENERATION='11111111-1111-1111-1111-111111111111'
OTHER_GENERATION='22222222-2222-2222-2222-222222222222'


class ProfileHistoryTests(unittest.TestCase):
    """A guard epoch change starts a new profile without losing the chat's conversation."""

    def setUp(self):
        try:from hermes_state import SessionDB
        except ImportError:self.skipTest('pinned Hermes runtime required')
        self.SessionDB=SessionDB
        self.folder=tempfile.TemporaryDirectory();self.root=Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def profile(self,epoch,chat='123',generation=GENERATION,purpose='assistant'):
        from .assistant_gateway import prepare_profile
        from .scopes import Scope, Scopes
        scope=Scopes.apply_revision(Scope(chat,chat,chat=='123','unused',chat),
                                    {'generation':generation,'guard_epoch':epoch,'revision':1,'purpose':purpose})
        return prepare_profile(self.root,scope,'subscription-model')

    def converse(self,profile,session='nocheh-chat',thread='a'*64):
        """An earlier private conversation with a tool call, a hidden fact and a compaction summary."""
        from .isolated_profile import database_path
        db=self.SessionDB(database_path(profile))
        try:
            db.create_session(session,source='telegram')
            db.append_message(session,role='user',content='[CONTEXT COMPACTION] earlier turns about '+FACT,_compressed_summary=True)
            db.append_message(session,role='user',content='My kite is named '+FACT+'.'+marker(PRIVATE))
            db.append_message(session,role='assistant',content='',tool_calls=json.loads(call('memory',{'content':'Kite: '+FACT})))
            db.append_message(session,role='tool',content='Saved '+FACT,tool_call_id='call-memory',tool_name='memory')
            db.append_message(session,role='assistant',content='Noted.',reasoning='Remember '+FACT)
            db.append_message(session,role='user',content='Plan a picnic for Saturday.'+marker(UNRELATED))
            db.append_message(session,role='assistant',content='Saturday picnic at the lake, noon.')
        finally:db.close()
        (profile/('active-'+thread+'.json')).write_text(json.dumps({'session_id':session}))

    def replay(self,profile,session='nocheh-chat'):
        from .isolated_profile import database_path
        if not database_path(profile).exists():return []
        db=self.SessionDB(database_path(profile),read_only=True)
        try:return db.get_messages_as_conversation(session) if db.get_session(session) else []
        finally:db.close()

    def test_new_epoch_keeps_the_conversation_without_tool_work_reasoning_or_summaries(self):
        old=self.profile(5);self.converse(old)
        new=self.profile(6)
        self.assertNotEqual(old,new)
        replay=self.replay(new)
        self.assertEqual([(m['role'],m['content'].split('\n')[0]) for m in replay],
                         [('user','My kite is named '+FACT+'.'),('assistant','Noted.'),
                          ('user','Plan a picnic for Saturday.'),('assistant','Saturday picnic at the lake, noon.')])
        self.assertIn(marker(PRIVATE).strip(),replay[0]['content'],'the archive marker lets retirements still find the turn')
        text=json.dumps(replay,ensure_ascii=False)
        self.assertNotIn('Saved '+FACT,text);self.assertNotIn('Remember',text);self.assertNotIn('COMPACTION',text)
        self.assertEqual(json.loads((new/('active-'+'a'*64+'.json')).read_text()),{'session_id':'nocheh-chat'})
        self.assertFalse((new/'memories/MEMORY.md').exists(),'native notes are not carried')
        # Preparing the same profile again copies nothing more.
        self.profile(6)
        self.assertEqual(len(self.replay(new)),4)

    def test_a_message_hidden_since_is_withheld_before_the_first_turn(self):
        from .isolated_profile import database_path
        from .retired_history import withhold_retired
        old=self.profile(5);self.converse(old)
        new=self.profile(6)
        withhold_retired(database_path(new),Lookup(retired=(PRIVATE,),answered=()))
        text=json.dumps(self.replay(new),ensure_ascii=False)
        self.assertNotIn(FACT,text)
        self.assertIn('Saturday picnic',text)

    def test_only_the_same_chat_installation_and_purpose_carry_and_used_profiles_are_left_alone(self):
        old=self.profile(5);self.converse(old)
        self.assertEqual(self.replay(self.profile(6,chat='-100')),[],'another chat')
        self.assertEqual(self.replay(self.profile(6,generation=OTHER_GENERATION)),[],'another installation')
        self.assertEqual(self.replay(self.profile(6,purpose='filter')),[],'filtering has its own context')
        self.assertEqual(self.replay(self.profile(4)),[],'an older epoch never adopts a newer one')
        used=self.profile(7)
        # A profile that already holds the chat's own session is never overwritten.
        from .isolated_profile import database_path
        db=self.SessionDB(database_path(used))
        try:db.append_message('nocheh-chat',role='user',content='Newer question.'+marker('9'*64))
        finally:db.close()
        (used/'.history-carried').unlink()
        self.profile(7)
        self.assertEqual(len(self.replay(used)),5)

    def test_newest_earlier_conversation_is_used_and_review_only_profiles_are_skipped(self):
        first=self.profile(5);self.converse(first)
        second=self.profile(6)
        from .isolated_profile import database_path
        db=self.SessionDB(database_path(second))
        try:db.append_message('nocheh-chat',role='user',content='What about Sunday?'+marker('8'*64))
        finally:db.close()
        review=self.profile(7,purpose='memory-review')
        (review/('active-'+'a'*64+'.json')).unlink()
        (review/'.history-carried').unlink()
        latest=self.profile(8)
        self.assertEqual(self.replay(latest)[-1]['content'].split('\n')[0],'What about Sunday?')


if __name__=='__main__':
    unittest.main()
