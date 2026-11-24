import fcntl
import json
import time
import unittest
from unittest.mock import patch

from .retired_history import NOTE_DELIMITER
from .test_retired_history import FACT, Lookup, OTHER_SOURCE, PRIVATE, QUESTION, UNRELATED, call, marker

WRITTEN='Kite: '+FACT                                 # what the PRIVATE turn's memory call wrote (ProfileHistoryTests.converse)
CITED='Kite colour is green (nocheh:event:'+PRIVATE+')'
RAIN='Rain is likely on Friday (nocheh:event:'+UNRELATED+')'
OWN='Prefers short replies'
REVIEW={'by':'review','review':'9'*64}
REPLIED='8'*64
NOTHING=dict(retired=(),answered=())


class Post:
    """Storage's answer whether notes may cross the epochs in between, recording what was asked."""
    def __init__(self,carry=True,failure=None):self.carry,self.failure,self.bodies=carry,failure,[]

    def __call__(self,body):
        self.bodies.append(body)
        if self.failure:raise self.failure
        return {'carry':self.carry}


class CarriedNotesTests(unittest.TestCase):
    """A chat keeps its Hermes notes in its profile for a newer guard epoch, minus those resting on a hidden message."""

    def setUp(self):
        try:import persistence_assembly  # noqa: F401
        except ImportError:self.skipTest('pinned Hermes runtime required')
        from .test_profile_history import ProfileHistoryTests
        self.case=ProfileHistoryTests();self.case.setUp();self.addCleanup(self.case.tearDown)

    def prepare(self,epoch,lookup=None,post=None,**scope):
        with patch('services.hermes.retired_history.service_lookup',lookup or Lookup(**NOTHING)),\
             patch('services.hermes.profile_notes.service_post',post or Post()):
            return self.case.profile(epoch,**scope)

    def write(self,profile,memory=(),user=(),records=None):
        from . import note_sources
        (profile/'memories').mkdir(exist_ok=True)
        (profile/'memories/MEMORY.md').write_text(NOTE_DELIMITER.join(memory))
        if user:(profile/'memories/USER.md').write_text(NOTE_DELIMITER.join(user))
        if records is not None:note_sources.save(profile,records)

    def notes(self,profile,name='MEMORY.md'):
        file=profile/'memories'/name
        return [entry for entry in file.read_text().split(NOTE_DELIMITER) if entry] if file.exists() else []

    def epoch_five(self,**scope):
        """A chat's earlier profile: a conversation whose PRIVATE turn wrote WRITTEN, and three more notes from a review."""
        from .note_sources import key
        old=self.prepare(5,**scope);self.case.converse(old)
        self.write(old,[WRITTEN,CITED,RAIN],[OWN],{key('memory',text):{'origins':[REVIEW],'more':0,'at':'2026-11-08'} for text in (CITED,RAIN)}|
                   {key('user',OWN):{'origins':[REVIEW],'more':0,'at':'2026-11-08'}})
        (old/'memories/MEMORY.md.bak.1700000000').write_text(WRITTEN+NOTE_DELIMITER+'An old drift copy')
        return old

    def test_notes_and_their_sources_carry_once(self):
        from . import note_sources
        from .note_sources import key
        from .profile_notes import CARRIED
        from .retired_history import load_dependencies
        old=self.epoch_five();post=Post()
        new=self.prepare(6,post=post)
        self.assertEqual(self.notes(new),[WRITTEN,CITED,RAIN]);self.assertEqual(self.notes(new,'USER.md'),[OWN])
        self.assertEqual(post.bodies,[{'generation':'11111111-1111-1111-1111-111111111111','from':5,'to':6,'owner':True}])
        self.assertEqual(set(note_sources.load(new)),{key('memory',CITED),key('memory',RAIN),key('user',OWN)},'each carried note keeps its source')
        reviewed={'turn':[],'sources':[REVIEW['review']]}
        self.assertEqual(load_dependencies(new)['entries'],{key('memory',WRITTEN):{'turn':[PRIVATE],'sources':[]},
                         key('memory',CITED):reviewed,key('memory',RAIN):reviewed,key('user',OWN):reviewed},
                         'the note a turn wrote keeps what that turn rests on, as its rows stay behind, and a review note its review')
        self.assertFalse(list((new/'memories').glob('*.bak.*')),'drift backups are not carried')
        self.assertEqual(json.loads((new/CARRIED).read_text())['notes'],4)
        self.assertEqual(self.notes(old),[WRITTEN,CITED,RAIN],'the earlier profile is read, not changed')
        self.assertEqual(len(self.case.replay(new)),4,'the conversation still carries')
        # Notes the new profile drops later are not brought back, and storage is not asked again.
        from .profile_notes import done
        (new/'memories/MEMORY.md').write_text(RAIN);again=Post()
        self.prepare(6,post=again)
        self.assertEqual(self.notes(new),[RAIN]);self.assertEqual(again.bodies,[]);self.assertTrue(done(new))

    def test_notes_resting_on_a_hidden_message_stay_behind(self):
        from . import note_sources
        from .note_sources import key
        self.epoch_five()
        new=self.prepare(6,lookup=Lookup(retired=(PRIVATE,),answered=()))
        self.assertEqual(self.notes(new),[RAIN],'a note citing it, and the note its turn wrote, are left behind')
        self.assertEqual(set(note_sources.load(new)),{key('memory',RAIN),key('user',OWN)})

    def test_notes_on_a_turn_whose_answer_was_hidden_stay_behind(self):
        self.epoch_five()
        new=self.prepare(6,lookup=Lookup(retired=(),answered=((PRIVATE,'e'*64),)))
        self.assertEqual(self.notes(new),[RAIN])

    def test_a_note_carried_twice_still_leaves_with_its_hidden_turn(self):
        """The turn's rows stay in epoch 5; epoch 6 keeps what its note rests on, so a hide in epoch 7 still removes it."""
        import time
        from .profile_history import IDLE_SECONDS, prune
        old=self.epoch_five()
        middle=self.prepare(6)
        self.assertEqual(prune(middle,now=time.time()+IDLE_SECONDS+60),[old.name])
        self.assertEqual(self.notes(middle),[WRITTEN,CITED,RAIN])
        newest=self.prepare(7,lookup=Lookup(retired=(PRIVATE,),answered=()))
        self.assertEqual(self.notes(newest),[RAIN])

    def test_a_turn_already_carried_is_checked_on_its_profiles_next_turn(self):
        from .isolated_profile import database_path
        from .retired_history import load_dependencies, withhold_retired
        self.epoch_five()
        new=self.prepare(6,lookup=Lookup(revision='1:a',**NOTHING))
        unchanged=Lookup(revision='1:a',retired=(PRIVATE,),answered=())
        withhold_retired(database_path(new),unchanged,new/'memories')
        self.assertNotIn([PRIVATE],unchanged.calls,'with no retirement since, the carried notes are not looked up again')
        withhold_retired(database_path(new),Lookup(revision='2:b',retired=(PRIVATE,),answered=()),new/'memories')
        self.assertEqual(self.notes(new),[RAIN])
        from .note_sources import key
        reviewed={'turn':[],'sources':[REVIEW['review']]}
        self.assertEqual(load_dependencies(new),{'checked':'2:b','entries':{key('memory',RAIN):reviewed,key('user',OWN):reviewed}})

    def test_what_a_turn_quoted_or_read_counts_two_epochs_later(self):
        from .native_store import writer
        from .store_fixture import add_message
        old=self.prepare(5);self.case.converse(old)
        reply=('[Replying to, by=member: A made-up name] (source nocheh:event:'+REPLIED+')\nThe picnic moved to the hill\n'
               '[End of replied-to message]\nPlease remember that.')
        with writer(old) as db:
            add_message(db,'nocheh-chat',role='user',content=reply+marker(QUESTION))
            add_message(db,'nocheh-chat',role='assistant',content='',tool_calls=json.loads(call('mcp__nocheh__archive_read',{'id':OTHER_SOURCE})))
            add_message(db,'nocheh-chat',role='tool',content='Rain gear is in the shed (nocheh:event:'+OTHER_SOURCE+')',
                        tool_call_id='call-mcp__nocheh__archive_read',tool_name='mcp__nocheh__archive_read')
            add_message(db,'nocheh-chat',role='assistant',content='',tool_calls=json.loads(call('memory',{'action':'add','content':'Picnic on the hill'})))
            add_message(db,'nocheh-chat',role='assistant',content='Noted.')
        self.write(old,['Picnic on the hill',RAIN])
        self.prepare(6)
        for hidden in (REPLIED,OTHER_SOURCE):
            with self.subTest(hidden=hidden):
                newest=self.prepare(7+[REPLIED,OTHER_SOURCE].index(hidden)*10,lookup=Lookup(retired=(hidden,),answered=()))
                self.assertEqual(self.notes(newest),[RAIN])

    def test_a_change_that_takes_something_away_starts_notes_fresh(self):
        import time
        from .profile_history import IDLE_SECONDS, prune
        from .profile_notes import CARRIED
        old=self.epoch_five()
        new=self.prepare(6,post=Post(carry=False))
        self.assertEqual(self.notes(new),[])
        self.assertTrue(json.loads((new/CARRIED).read_text())['fresh'])
        self.assertEqual(prune(new,now=time.time()+IDLE_SECONDS+60),[old.name])
        self.assertEqual(self.notes(self.prepare(7)),[],'notes written before the change never come back later')

    def test_a_carry_that_cannot_finish_now_keeps_the_earlier_profile_and_tries_again(self):
        import time
        from .profile_history import IDLE_SECONDS, prune
        old=self.epoch_five()
        new=self.prepare(6,post=Post(failure=OSError('storage unavailable')))
        self.assertEqual(self.notes(new),[])
        self.assertEqual(prune(new,now=time.time()+IDLE_SECONDS+60),[],'the earlier notes are kept until they carry')
        # A run in the new profile wrote a note meanwhile; the earlier notes come first, its own after them.
        self.write(new,['Booked the lake for noon',RAIN])
        with patch('services.hermes.profile_notes.LOCK_SECONDS',.2),(old/'.turn.lock').open('a') as busy:
            fcntl.flock(busy,fcntl.LOCK_EX)
            self.prepare(6)
            self.assertEqual(self.notes(new),['Booked the lake for noon',RAIN],'a run still in the earlier profile is waited for')
        self.prepare(6)
        self.assertEqual(self.notes(new),[WRITTEN,CITED,RAIN,'Booked the lake for noon'])
        self.assertEqual(prune(new,now=time.time()+IDLE_SECONDS+60),[old.name])

    def test_groups_carry_their_own_notes_and_other_profiles_none(self):
        from .assistant_gateway import prepare_profile
        from .scopes import Scope, Scopes
        post=Post()
        group=self.prepare(5,chat='-100');self.write(group,[RAIN])
        self.assertEqual(self.notes(self.prepare(6,chat='-100',post=post)),[RAIN])
        self.assertFalse(post.bodies[0]['owner'],"a group's notes carry only across what keeps every chat's")
        self.epoch_five()
        self.assertEqual(self.notes(self.prepare(6,logical='profile-'+'b'*48)),[],'a named profile keeps its own notes only')
        self.assertEqual(self.notes(self.prepare(6,generation='22222222-2222-2222-2222-222222222222')),[],'another installation')
        asked=Post()
        def member(epoch):
            claims={'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':epoch,'revision':1}
            scope=Scopes.apply_revision(Scope('-200','-200',False,'unused','-200',member='7'*64),claims)
            with patch('services.hermes.profile_notes.service_post',asked):
                return prepare_profile(self.case.root,scope,'subscription-model')
        first=member(5);self.write(first,[WRITTEN])
        self.assertEqual(self.notes(member(6)),[],"a member's private chat writes no notes and carries none")
        self.assertEqual(asked.bodies,[],'storage is never asked for one')

    def test_an_earlier_carry_that_did_not_finish_finishes_first(self):
        """Epoch 6's carry could not wait for a run in epoch 5 and a run in 6 wrote a note; epoch 7 still gets 5's notes."""
        from .profile_history import IDLE_SECONDS, prune
        from .profile_notes import done
        old=self.epoch_five()
        with patch('services.hermes.profile_notes.LOCK_SECONDS',.2),(old/'.turn.lock').open('a') as busy:
            fcntl.flock(busy,fcntl.LOCK_EX)
            middle=self.prepare(6)
        self.assertFalse(done(middle))
        self.write(middle,['Booked the lake for noon'])
        newest=self.prepare(7)
        self.assertEqual(self.notes(newest),[WRITTEN,CITED,RAIN,'Booked the lake for noon'])
        self.assertEqual(self.notes(middle),[WRITTEN,CITED,RAIN,'Booked the lake for noon'],'epoch 6 finished its own carry on the way')
        self.assertEqual(sorted(prune(newest,now=time.time()+IDLE_SECONDS+60)),sorted([old.name,middle.name]))

    def test_a_chat_without_notes_yet_waits_for_a_run_still_in_its_earlier_profile(self):
        from .profile_notes import done
        old=self.prepare(5)
        with patch('services.hermes.profile_notes.LOCK_SECONDS',.2),(old/'.turn.lock').open('a') as busy:
            fcntl.flock(busy,fcntl.LOCK_EX)
            new=self.prepare(6)
            self.assertFalse(done(new),'nothing is decided while a run there may still write its first note')
            self.write(old,[RAIN])
        self.prepare(6)
        self.assertEqual(self.notes(new),[RAIN])

    def test_a_carry_that_can_never_finish_starts_fresh_and_one_failing_for_a_day_gives_up(self):
        from .profile_history import IDLE_SECONDS, prune
        from .profile_notes import CARRIED, GIVE_UP_SECONDS, done
        old=self.epoch_five();new=self.prepare(6,post=Post(failure=OSError('storage unavailable')))
        self.assertFalse(done(new))
        marker=json.loads((new/CARRIED).read_text());self.assertEqual(marker['error'],'OSError')
        (new/CARRIED).write_text(json.dumps({**marker,'since':marker['since']-GIVE_UP_SECONDS}))
        self.prepare(6,post=Post(failure=OSError('storage unavailable')))
        self.assertTrue(done(new));self.assertTrue(json.loads((new/CARRIED).read_text())['fresh'])
        self.assertEqual(prune(new,now=time.time()+IDLE_SECONDS+60),[old.name])

    def test_notes_the_new_profile_cannot_read_start_fresh_at_once(self):
        from .profile_history import IDLE_SECONDS, prune
        from .profile_notes import CARRIED, done
        old=self.epoch_five();new=self.prepare(6,post=Post(failure=OSError('storage unavailable')))
        (new/'memories').mkdir(exist_ok=True);(new/'memories/MEMORY.md').write_bytes(b'\xff\xfe broken')
        self.prepare(6)
        marker=json.loads((new/CARRIED).read_text())
        self.assertTrue(done(new));self.assertEqual((marker['fresh'],marker['failed']),(True,'ValueError'))
        self.assertEqual(prune(new,now=time.time()+IDLE_SECONDS+60),[old.name],'the earlier profile is not kept for ever')

    def test_carried_notes_never_stand_without_what_they_rest_on(self):
        from .profile_notes import done
        self.epoch_five()
        with patch('services.hermes.retired_history.save_dependencies',side_effect=OSError('disk full')):new=self.prepare(6)
        self.assertEqual(self.notes(new),[],'no note is written before its dependencies')
        self.assertFalse(done(new))
        self.prepare(6);self.assertEqual(self.notes(new),[WRITTEN,CITED,RAIN])

    def test_a_note_leaves_with_any_turn_or_review_its_record_names(self):
        """A note rewritten by a later turn keeps its first turn's origin, and a review's note its review (ADR-0257)."""
        from .note_sources import key
        old=self.prepare(5);review='9'*64
        turn={'by':'turn','event':PRIVATE,'channel':'telegram','at':'2026-11-08','reads':[],'complete':True}
        self.write(old,['Alice lives at 14 Elm Street','A review note',RAIN],records={
            key('memory','Alice lives at 14 Elm Street'):{'origins':[{**turn,'event':REPLIED},turn],'more':0,'at':'2026-11-08'},
            key('memory','A review note'):{'origins':[{'by':'review','review':review}],'more':0,'at':'2026-11-08'}})
        self.assertEqual(self.notes(self.prepare(6,lookup=Lookup(retired=(PRIVATE,review),answered=()))),[RAIN])

    def test_a_note_leaves_with_the_long_term_memory_its_turn_was_given(self):
        from .isolated_profile import database_path
        from .retired_history import add_dependencies, withhold_retired
        memory='6'*64
        old=self.prepare(5);self.write(old,[RAIN])
        add_dependencies(old,{'memory':[],'user':[]},[OTHER_SOURCE],[memory])
        self.assertEqual(self.notes(self.prepare(6,lookup=Lookup(retired=(memory,),answered=()))),[],'it does not carry')
        self.write(old,[RAIN])
        withhold_retired(database_path(old),Lookup(retired=(memory,),answered=()),old/'memories')
        self.assertEqual(self.notes(old),[],'nor stays where it was written')

    def test_what_notes_rest_on_is_never_lost_to_a_read_error(self):
        from .profile_notes import CARRIED, done
        from .retired_history import DEPENDENCIES, save_dependencies
        from .note_sources import key
        old=self.epoch_five();save_dependencies(old,'1:a',{key('memory',RAIN):{'turn':[],'sources':[OTHER_SOURCE]}})
        (old/DEPENDENCIES).unlink();(old/DEPENDENCIES).mkdir()
        new=self.prepare(6)
        self.assertEqual(self.notes(new),[]);self.assertFalse(done(new),'a read error is tried again, never carried past')
        (old/DEPENDENCIES).rmdir();(old/DEPENDENCIES).write_text('{"version":1,"entries":"damaged"}')
        self.prepare(6)
        self.assertEqual(self.notes(new),[]);self.assertTrue(json.loads((new/CARRIED).read_text())['fresh'],'a damaged file never reads: fresh')

    def test_a_group_note_from_a_granted_fact_leaves_once_the_grant_lapses(self):
        from .retired_history import add_dependencies
        grant='5'*64
        class Lapsed(Lookup):
            def __call__(self,event_ids):return {**super().__call__(event_ids),'lapsed_grants':sorted({grant}&set(event_ids))}
        for chat,kept in (('-100',[]),(None,[RAIN])):
            with self.subTest(chat=chat):
                scope={'chat':chat} if chat else {}
                old=self.prepare(5,**scope);self.write(old,[RAIN])
                add_dependencies(old,{'memory':[],'user':[]},[OTHER_SOURCE],[grant])
                self.assertEqual(self.notes(self.prepare(6,lookup=Lapsed(**NOTHING),**scope)),kept,'the owner\'s chat reads everything')

    def test_unreadable_notes_carry_nothing(self):
        from .profile_notes import CARRIED
        old=self.epoch_five()
        (old/'memories/MEMORY.md').write_bytes(b'\xff\xfe broken')
        new=self.prepare(6)
        self.assertEqual(self.notes(new),[])
        self.assertTrue(json.loads((new/CARRIED).read_text())['unreadable'])


if __name__=='__main__':
    unittest.main()
