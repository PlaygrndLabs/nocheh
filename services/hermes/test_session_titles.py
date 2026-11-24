import tempfile
import unittest
from pathlib import Path


class SessionTitleTests(unittest.TestCase):
    """A Telegram session is listed under its chat's name instead of its first message."""

    def setUp(self):
        try:import persistence_assembly  # noqa: F401
        except ImportError:self.skipTest('pinned Hermes runtime required')
        self.folder=tempfile.TemporaryDirectory();self.profile=Path(self.folder.name)
        (self.profile/'native-state').mkdir()

    def tearDown(self):
        self.folder.cleanup()

    def session(self,session_id,title=None):
        from .native_store import writer
        from .store_fixture import add_message, add_session
        with writer(self.profile) as db:
            add_session(db,session_id)
            add_message(db,session_id,'user','Hi [Archive source: nocheh:event:'+'a'*64+']')
            if title:db.sessions.set_title(session_id,title)

    def title(self,session_id):
        from .native_store import reader
        with reader(self.profile) as db:
            record=db.sessions.get(session_id)
            return None if record is None else record.title

    def test_names_follow_the_chat_and_its_topic(self):
        from .assistant_gateway import session_title
        group={'chat':{'id':-100,'type':'supergroup','title':'Garden club','is_forum':True}}
        self.assertEqual(session_title({'chat':{'id':42,'type':'private','first_name':'Sam'}},True),'Private chat')
        self.assertEqual(session_title(group,False),'Garden club')
        self.assertEqual(session_title({'chat':{'id':42,'type':'private','first_name':'Sam'}},False,True),'Private answer',
                         'a private answer\'s session never takes the private chat\'s name')
        self.assertEqual(session_title({'chat':{'id':-100,'type':'group'}},False),'Telegram group')
        opened={**group,'message_thread_id':7,'is_topic_message':True,
                'reply_to_message':{'message_id':7,'forum_topic_created':{'name':'Seeds'}}}
        self.assertEqual(session_title(opened,False),'Garden club › Seeds')
        self.assertEqual(session_title({**group,'message_thread_id':7,'is_topic_message':True},False),'Garden club › topic 7')
        self.assertEqual(len(session_title({'chat':{'type':'supergroup','title':'x'*200}},False)),90)

    def test_an_untitled_session_gets_its_chat_name_once_and_a_hand_set_title_stays(self):
        from .assistant_gateway import title_session
        message={'chat':{'id':-100,'type':'supergroup','title':'Garden club'}}
        self.session('nocheh-first')
        title_session(self.profile,'nocheh-first',message,False)
        self.assertEqual(self.title('nocheh-first'),'Garden club')
        # Another session of the same chat gets the next name in Hermes's own numbering.
        self.session('nocheh-second')
        title_session(self.profile,'nocheh-second',message,False)
        self.assertEqual(self.title('nocheh-second'),'Garden club #2')
        self.session('nocheh-named',title='Our plans')
        title_session(self.profile,'nocheh-named',message,False)
        self.assertEqual(self.title('nocheh-named'),'Our plans')
        title_session(self.profile,'nocheh-missing',message,False)
        self.assertIsNone(self.title('nocheh-missing'))

    def test_a_first_message_title_gives_way_to_the_chat_name(self):
        from .assistant_gateway import title_session
        from persistence.conversation.sessions import TitleSource
        from .native_store import writer
        self.session('nocheh-earlier')
        with writer(self.profile) as db:db.sessions.set_auto_title('nocheh-earlier','Hi [Archive source: nocheh:event:aaaa',source=TitleSource.DERIVED)
        title_session(self.profile,'nocheh-earlier',{'chat':{'id':42,'type':'private'}},True)
        self.assertEqual(self.title('nocheh-earlier'),'Private chat')

    def test_hermes_leaves_a_telegram_session_for_its_chat_name(self):
        from agent import turn_context
        from .assistant_turn import untitled_telegram
        from .native_store import writer
        original=turn_context._UNTITLED_PLATFORMS
        self.addCleanup(setattr,turn_context,'_UNTITLED_PLATFORMS',original)
        untitled_telegram();untitled_telegram()
        self.assertEqual(turn_context._UNTITLED_PLATFORMS,original|{'telegram'},'browser and job sessions keep Hermes titles')
        self.session('nocheh-turn')
        with writer(self.profile) as db:
            agent=type('Agent',(),{'_session_db':db,'persistence':db,'session_id':'nocheh-turn','platform':'telegram','_session_db_created':True})()
            turn_context._maybe_title_session_at_turn_start(agent,[{'role':'user','content':'Hi there'}])
        self.assertIsNone(self.title('nocheh-turn'))


if __name__=='__main__':
    unittest.main()
