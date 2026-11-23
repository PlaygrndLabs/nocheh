import tempfile
import json
import unittest
from pathlib import Path
from .scopes import Scopes
from services.chats import Served
from .management import dispatch, profile_path


class ManagementTests(unittest.TestCase):
    def test_native_notes_sessions_pagination_and_wrong_profile(self):
        from .native_store import writer
        from .store_fixture import add_message, add_session
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20','-30']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for chat in ('-20','-30'):
                profile=profile_path(root,chat,policy);(profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('  note '+chat+'\n'+'nocheh:event:'+'a'*64)
                with writer(profile) as db:
                    add_session(db,'session'+chat)
                    for i in range(52):add_message(db,'session'+chat,'user',f'{chat}: {i}')
            call=lambda **body:dispatch(root,'test-model',policy,body)
            result=call(action='memory',scope='-20');self.assertEqual(result['memories'][0]['text'][:2],'  ')
            self.assertEqual(result['memories'][0]['citations'],['a'*64]);self.assertEqual(len(result['sessions']),1)
            result=call(action='memory',scope='-20',session='session-20');self.assertEqual(len(result['messages']),50);self.assertEqual(result['next_offset'],50)
            result=call(action='memory',scope='-20',session='session-20',offset=50);self.assertEqual(len(result['messages']),2);self.assertIsNone(result['next_offset'])
            for body in ({'scope':'-99'}, {'scope':'-20','session':'session-30'}, {'scope':'-20','offset':-1}):
                with self.assertRaises(ValueError):call(action='memory',**body)
            self.assertFalse(call(action='memory',scope='123')['memories'][0]['exists'])
            self.assertFalse(call(action='memory',scope='123',profile=Scopes.profile('123'))['memories'][0]['exists'])
            (profile_path(root,'123',policy)/'memories').mkdir(parents=True)
            (profile_path(root,'123',policy)/'memories/MEMORY.md').symlink_to(root/'profiles'/Scopes.profile('-30')/'memories/MEMORY.md')
            with self.assertRaises(ValueError):call(action='memory',scope='123')

    def test_past_conversations_leave_out_empty_and_hidden_sessions_and_name_each_one(self):
        # A memory review hides its own session and an empty one has nothing to read; neither is a past conversation.
        # Each listed one carries its title, its first message without Nocheh's archive source, and when it went on.
        from .native_store import writer
        from .store_fixture import add_message, add_session
        policy=Scopes({'enabled':True},Served.of('123'))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=profile_path(root,'123',policy);profile.mkdir(parents=True)
            with writer(profile) as db:
                add_session(db,'nocheh-chat');db.sessions.set_title('nocheh-chat','Private chat')
                add_message(db,'nocheh-chat','user','Plan the trip\n\n[Archive source: nocheh:event:'+'a'*64+']')
                add_message(db,'nocheh-chat','assistant','Sure.')
                add_session(db,'browser-1','browser');add_message(db,'browser-1','user','What did I save?')
                add_session(db,'review-1');add_message(db,'review-1','user','review text')
                db.sessions.set_hidden('review-1',True)
                add_session(db,'empty-1')
            call=lambda **body:dispatch(root,'test-model',policy,body)
            rows={row['id']:row for row in call(action='memory',scope='123')['sessions']}
            self.assertEqual(set(rows),{'nocheh-chat','browser-1'})
            chat=rows['nocheh-chat']
            self.assertEqual((chat['title'],chat['preview'],chat['source'],chat['messages']),('Private chat','Plan the trip','telegram',2))
            self.assertTrue(chat['last_active'].endswith('Z'));self.assertTrue(chat['started_at'].endswith('Z'))
            self.assertEqual((rows['browser-1']['title'],rows['browser-1']['preview']),('','What did I save?'))
            first=call(action='memory',scope='123',limit=1);self.assertEqual(len(first['sessions']),1);self.assertEqual(first['next_offset'],1)
            second=call(action='memory',scope='123',limit=1,offset=1);self.assertEqual(len(second['sessions']),1);self.assertIsNone(second['next_offset'])
            self.assertNotEqual(first['sessions'][0]['id'],second['sessions'][0]['id'])
            for limit in (0,51,'5'):
                with self.assertRaises(ValueError):call(action='memory',scope='123',limit=limit)

    def test_each_note_is_listed_on_its_own_with_what_was_recorded_about_who_wrote_it(self):
        # Storage puts each note's record in the owner's words (ADR-0257); a file Hermes could not read lists no notes,
        # and the page shows it whole.
        from . import note_sources
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=profile_path(root,'-20',policy);(profile/'memories').mkdir(parents=True)
            (profile/'memories/MEMORY.md').write_text('Alice likes tea.\n§\nBob is away.\n§\nAlice likes tea.')
            (profile/'memories/USER.md').write_text('Sara leads Work.')
            origin={'by':'turn','event':'c'*64,'channel':'telegram','at':'2026-11-08','reads':['recent'],'complete':True}
            note_sources.save(profile,{note_sources.key('memory','Bob is away.'):{'origins':[origin],'more':0,'at':'2026-11-08'}})
            memories={m['name']:m for m in dispatch(root,'test-model',policy,{'action':'memory','scope':'-20'})['memories']}
            self.assertEqual(memories['MEMORY.md']['entries'],[
                {'target':'memory','text':'Alice likes tea.','key':note_sources.key('memory','Alice likes tea.'),'origins':[{'by':'unknown'}],'more':0,'cites':[]},
                {'target':'memory','text':'Bob is away.','key':note_sources.key('memory','Bob is away.'),'origins':[origin],'more':0,'cites':[]}])
            self.assertEqual([e['text'] for e in memories['USER.md']['entries']],['Sara leads Work.'])
            (profile/'memories/USER.md').write_bytes(b'\xff not text')
            memories={m['name']:m for m in dispatch(root,'test-model',policy,{'action':'memory','scope':'-20'})['memories']}
            self.assertNotIn('entries',memories['MEMORY.md']);self.assertNotIn('entries',memories['USER.md'])
            self.assertEqual(memories['MEMORY.md']['text'],'Alice likes tea.\n§\nBob is away.\n§\nAlice likes tea.')

    def test_a_project_role_and_skills_are_kept_in_their_own_folder(self):
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);call=lambda **body:dispatch(root,'test-model',policy,body);scope='project:'+'d'*64
            first=call(action='persona',scope=scope)
            self.assertEqual((first['scope'],first['role'],first['skills']),(scope,'',[]))
            call(action='persona',scope=scope,role='Client project role',skills=[],revision=first['revision'])
            self.assertEqual((root/'projects'/('d'*64)/'SOUL.md').read_text(),'Client project role\n')
            for bad in ('project:../profiles','project:'+'D'*64):
                with self.assertRaises(ValueError):call(action='persona',scope=bad)

    def test_the_private_chats_and_the_groups_defaults_are_kept_apart(self):
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);call=lambda **body:dispatch(root,'test-model',policy,body)
            private,groups=call(action='persona',scope='default'),call(action='persona',scope='default:groups')
            self.assertEqual((groups['scope'],groups['role'],groups['skills']),('default:groups','',[]))
            saved=call(action='persona',scope='default:groups',role='Group role',skills=[],revision=groups['revision'])
            self.assertEqual((root/'nocheh-default-groups'/'SOUL.md').read_text(),'Group role\n')
            self.assertEqual(call(action='persona',scope='default'),private,'a groups save never changes the private chat\'s default')
            call(action='persona',scope='default',role='Private role',skills=[],revision=private['revision'])
            self.assertEqual(call(action='persona',scope='default:groups'),saved,'and the other way round')
            self.assertEqual((root/'nocheh-default'/'SOUL.md').read_text(),'Private role\n')
            with self.assertRaisesRegex(ValueError,'configuration_conflict'):
                call(action='persona',scope='default:groups',role='Stale',skills=[],revision=groups['revision'])
            for bad in ('default:members','default:'):
                with self.assertRaises(ValueError):call(action='persona',scope=bad)

    def test_owner_inspects_retired_topic_notes_by_registered_profile(self):
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);name=Scopes.profile('-20/topic/1:policy:2');path=root/'profiles'/name
            (path/'memories').mkdir(parents=True)
            (path/'space.json').write_text(json.dumps({'space':'-20/topic/1','revision':2,'guard_epoch':7,'owner':False}))
            (path/'memories/MEMORY.md').write_text('Historical topic note')
            listing=dispatch(root,'test',policy,{'action':'profiles'})
            self.assertTrue(any(p.get('revision')==2 for p in listing['history_profiles']))
            self.assertTrue(any(p.get('guard_epoch')==7 for p in listing['history_profiles']))
            result=dispatch(root,'test',policy,{'action':'memory','scope':'-20/topic/1','profile':name})
            self.assertEqual(result['memories'][0]['text'],'Historical topic note')
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{'action':'memory','scope':'-20/topic/2','profile':name})

    def test_a_private_answers_profile_is_named_by_its_receipt(self):
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,receipt in (('nocheh-'+'a1'*12,{'group':'“Team” › Plans','at':'2026-11-12T10:00:00+00:00'}),('nocheh-'+'b2'*12,None)):
                path=root/'profiles'/name;path.mkdir(parents=True)
                (path/'space.json').write_text(json.dumps({'space':'123','revision':1,'guard_epoch':1,'owner':False,'answer':'a'*32}))
                if receipt:(path/'answer.json').write_text(json.dumps(receipt))
            listing={p['profile']:p for p in dispatch(root,'test',policy,{'action':'profiles'})['history_profiles']}
            named=listing['nocheh-'+'a1'*12]
            self.assertEqual((named['private_answer'],named['answer_group'],named['answer_at']),(True,'“Team” › Plans','2026-11-12T10:00:00+00:00'))
            self.assertNotIn('answer_group',listing['nocheh-'+'b2'*12],'one from before the receipt names nothing')
            self.assertTrue(listing['nocheh-'+'b2'*12]['private_answer'])

    def test_the_newest_setup_of_a_chat_is_marked_latest(self):
        # After a reinstall the owner's chat has a profile per setup; the base one may not exist on disk. Only the newest
        # existing one is marked latest, so the dashboard's Notes opens on the notes the chat uses now.
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,meta in (('nocheh-'+'a1'*12,{'space':'123','owner':True,'revision':1,'guard_epoch':2}),
                              ('nocheh-'+'b2'*12,{'space':'123','owner':True,'revision':1,'guard_epoch':5}),
                              ('nocheh-'+'c3'*12,{'space':'123','owner':False,'revision':1,'guard_epoch':9,'answer':'a'*32}),
                              ('nocheh-'+'d4'*12,{'space':'-20','owner':False,'revision':3,'guard_epoch':5})):
                path=root/'profiles'/name;path.mkdir(parents=True)
                (path/'space.json').write_text(json.dumps(meta))
            listing={p['profile']:p for p in dispatch(root,'test',policy,{'action':'profiles'})['history_profiles']}
            self.assertFalse(listing[Scopes.profile('123')]['exists'])
            self.assertEqual([p for p,v in listing.items() if v.get('latest')],['nocheh-'+'b2'*12,'nocheh-'+'d4'*12])
            self.assertFalse(listing['nocheh-'+'a1'*12]['latest'])
            self.assertFalse(listing[Scopes.profile('123')]['latest'])
            self.assertNotIn('latest',listing['nocheh-'+'c3'*12],'a private answer is never a chat\'s current notes')

    def test_after_a_reinstall_the_new_installations_notes_are_latest(self):
        # A reinstall starts guard epochs again at 1, and the old installation's profiles stay on disk at their high
        # epochs. The installation whose notes were used last is the current one, whatever its epoch.
        import os
        policy=Scopes({'enabled':True},Served.of('123'))
        old,new='11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,meta,used in (('nocheh-'+'a1'*12,{'space':'123','owner':True,'revision':1,'guard_epoch':40,'generation':old},1_000_000),
                                   ('nocheh-'+'b2'*12,{'space':'123','owner':True,'revision':1,'guard_epoch':2,'generation':new},2_000_000)):
                path=root/'profiles'/name;path.mkdir(parents=True)
                (path/'space.json').write_text(json.dumps(meta));os.utime(path/'space.json',(used,used))
            listing={p['profile']:p for p in dispatch(root,'test',policy,{'action':'profiles'})['history_profiles']}
            self.assertTrue(listing['nocheh-'+'b2'*12]['latest'])
            self.assertFalse(listing['nocheh-'+'a1'*12]['latest'])

    def test_a_named_profile_beside_the_chat_is_never_its_current_notes(self):
        # A named owner profile has the same chat, setup and owner as the chat's own one; only the chat's own profile is
        # its current notes, and the named one carries no mark either way.
        policy=Scopes({'enabled':True},Served.of('123'))
        generation='22222222-2222-4222-8222-222222222222'
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            own={'space':'123','owner':True,'revision':1,'guard_epoch':3,'generation':generation,'logical_profile':Scopes.profile('123')}
            for name,meta in (('nocheh-'+'00'*12,{**own,'logical_profile':'profile-'+'ab'*24}),('nocheh-'+'ff'*12,own)):
                path=root/'profiles'/name;path.mkdir(parents=True)
                (path/'space.json').write_text(json.dumps(meta))
            listing={p['profile']:p for p in dispatch(root,'test',policy,{'action':'profiles'})['history_profiles']}
            self.assertNotIn('latest',listing['nocheh-'+'00'*12])
            self.assertTrue(listing['nocheh-'+'ff'*12]['latest'])
            self.assertFalse(listing[Scopes.profile('123')]['latest'])

    def test_a_members_chat_and_an_ask_about_a_member_are_marked_as_such(self):
        # Step 4 and 4b: the dashboard's Notes names these profiles as a member's and as the owner's question, never as
        # the owner's own chat or a group.
        policy=Scopes({'enabled':True},Served.of('123',groups=['-20']))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name,extra in (('nocheh-'+'c3'*12,{'space':'4567','member':'d'*64}),('nocheh-'+'d4'*12,{'space':'123','member_read':'e'*32}),
                               ('nocheh-'+'e5'*12,{'space':'123','owner':True})):
                path=root/'profiles'/name;path.mkdir(parents=True)
                (path/'space.json').write_text(json.dumps({'revision':1,'guard_epoch':1,'owner':False,**extra}))
                # The ask's receipt dates it, as a private answer's does; a group name in it is never shown for an ask.
                if 'member_read' in extra:(path/'answer.json').write_text(json.dumps({'at':'2026-11-12T10:00:00+00:00','group':'“Injected”'}))
            listing={p['profile']:p for p in dispatch(root,'test',policy,{'action':'profiles'})['history_profiles']}
            member,ask,owner=(listing['nocheh-'+part*12] for part in ('c3','d4','e5'))
            self.assertEqual((member.get('member'),member.get('member_read'),member['owner']),(True,None,False))
            self.assertEqual((ask.get('member'),ask.get('member_read'),ask['owner']),(None,True,False))
            self.assertEqual((ask.get('answer_at'),ask.get('answer_group'),ask.get('private_answer')),('2026-11-12T10:00:00+00:00',None,None))
            self.assertNotIn('answer_at',member)
            self.assertEqual((owner.get('member'),owner.get('member_read')),(None,None))

    def test_preferences_use_revision_and_policy(self):
        policy=Scopes({'enabled':True},Served.of('123'))
        with tempfile.TemporaryDirectory() as root:
            request={'action':'preferences','scope':'123'}
            first=dispatch(root,'test',policy,request)
            self.assertEqual(list(Path(root).iterdir()),[],'Viewing preferences must not mutate a backup source')
            updated=dispatch(root,'test',policy,{**request,'revision':first['revision'],'changes':{'agent.max_iterations':4}})
            self.assertEqual(updated['values']['agent.max_iterations'],4)
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{**request,'revision':first['revision'],'changes':{'agent.max_iterations':5}})
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{**request,'revision':updated['revision'],'changes':{'model.provider':'unsafe'}})


class SettingsErrorRelayTests(unittest.TestCase):
    def test_settings_validation_says_what_to_fix_and_other_errors_stay_generic(self):
        import io
        import json
        from contextlib import redirect_stdout
        from unittest.mock import patch
        from tools.runtime import management

        def run(operation, error):
            out = io.StringIO()
            stdin = type('In', (), {'buffer': io.BytesIO(json.dumps({'operation': operation}).encode())})()
            with patch.object(management, 'dispatch', side_effect=error), patch.object(management.sys, 'stdin', stdin), redirect_stdout(out):
                management.main()
            return json.loads(out.getvalue())['error']

        self.assertEqual(run('settings.save', ValueError('Memory (Honcho) needs a model name')), 'Memory (Honcho) needs a model name')
        self.assertEqual(run('settings.save', ValueError('configuration_conflict')), 'configuration_conflict')
        from tools.operations.installation.settings import OWNER_FROM_CLI
        self.assertEqual(run('settings.save', ValueError(OWNER_FROM_CLI)), OWNER_FROM_CLI)
        self.assertEqual(run('archive.view', ValueError('upstream said secret-value here')), 'ValueError')
        self.assertEqual(run('settings.save', RuntimeError('provider body')), 'RuntimeError')
