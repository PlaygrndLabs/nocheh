import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from . import persona
from .scopes import Scopes

COOKING = {'name': 'weekly-menu', 'description': 'When someone asks what to cook this week.',
           'body': 'Suggest five dinners that use what is already in the fridge.'}


class PersonaTests(unittest.TestCase):
    def test_owner_role_and_skills_are_saved_in_hermes_profile_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            path = persona.chat_path(folder, '-20')
            first = persona.view(path)
            self.assertEqual((first['role'], first['skills']), ('', []))
            saved = persona.save(path, 'You help the family plan meals.\n', [COOKING], first['revision'])
            self.assertEqual((path / 'SOUL.md').read_text(), 'You help the family plan meals.\n')
            text = (path / 'skills' / 'weekly-menu' / 'SKILL.md').read_text()
            self.assertTrue(text.startswith('---\nname: weekly-menu\ndescription: When someone asks'))
            self.assertEqual(saved['skills'], [COOKING])
            self.assertEqual(persona.view(path), saved)

    def test_stale_revision_and_invalid_skills_change_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = persona.chat_path(folder, '-20')
            start = persona.view(path)['revision']
            persona.save(path, 'First role', [], start)
            with self.assertRaisesRegex(ValueError, 'configuration_conflict'):
                persona.save(path, 'Second role', [], start)
            current = persona.view(path)['revision']
            for skills in ([{**COOKING, 'name': 'Bad Name'}], [{**COOKING, 'body': ' '}], [COOKING, COOKING],
                           [{**COOKING, 'extra': 'x'}], [COOKING] * 31):
                with self.assertRaisesRegex(ValueError, 'invalid_persona'):
                    persona.save(path, 'Third role', skills, current)
            with self.assertRaisesRegex(ValueError, 'invalid_persona'):
                persona.save(path, 'x' * (persona.ROLE_LIMIT + 1), [], current)
            self.assertEqual(persona.read(path)['role'], 'First role')

    def test_removing_a_skill_deletes_its_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            path = persona.default_path(folder)
            saved = persona.save(path, '', [COOKING, {**COOKING, 'name': 'groceries'}], persona.view(path)['revision'])
            persona.save(path, '', [COOKING], saved['revision'])
            self.assertEqual(sorted(p.name for p in (path / 'skills').iterdir()), ['weekly-menu'])

    def test_turn_profile_gets_chat_role_over_default_and_both_skill_sets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            default, chat = persona.default_path(root), persona.chat_path(root, '-20')
            persona.save(default, 'Default role', [COOKING, {**COOKING, 'name': 'reminders', 'body': 'Default reminders.'}],
                         persona.view(default)['revision'])
            persona.save(chat, '', [{**COOKING, 'name': 'reminders', 'body': 'Group reminders.'}], persona.view(chat)['revision'])
            turn = root / 'profiles' / Scopes.profile('-20:policy:3'); turn.mkdir(parents=True)
            persona.materialize(root, turn, '-20')
            value = persona.read(turn)
            self.assertEqual(value['role'], 'Default role')
            self.assertEqual({s['name']: s['body'] for s in value['skills']},
                             {'reminders': 'Group reminders.', 'weekly-menu': COOKING['body']})
            persona.save(chat, 'Group role', [], persona.view(chat)['revision'])
            persona.materialize(root, turn, '-20')
            self.assertEqual(persona.read(turn), {'role': 'Group role', 'skills': [
                {**COOKING, 'name': 'reminders', 'body': 'Default reminders.'}, COOKING]})
            self.assertEqual(persona.read(chat)['skills'], [], 'the owner source is never rewritten by a turn')

    def test_a_turn_profile_whose_refresh_request_failed_asks_again_on_the_next_turn(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chat = persona.chat_path(root, '-20')
            persona.save(chat, 'Group role', [], persona.view(chat)['revision'])
            turn = root / 'profiles' / Scopes.profile('-20:policy:3'); turn.mkdir(parents=True)
            with patch.object(persona, '_refresh_prompts', side_effect=OSError('database is locked')):
                with self.assertRaises(OSError): persona.materialize(root, turn, '-20')
            self.assertFalse((turn / 'SOUL.md').exists())
            self.assertEqual(persona.read(chat)['role'], 'Group role', 'the owner source is never removed')
            with patch.object(persona, '_refresh_prompts') as refresh:
                persona.materialize(root, turn, '-20')
                persona.materialize(root, turn, '-20')
            refresh.assert_called_once_with(turn)
            self.assertEqual(persona.read(turn)['role'], 'Group role')

    def test_a_chats_project_adds_its_role_and_skills_between_the_default_and_the_chats_own(self):
        project = 'a' * 64
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            default, shared, chat = persona.default_path(root), persona.project_path(root, project), persona.chat_path(root, '-20')
            persona.save(default, 'Default role', [COOKING], persona.view(default)['revision'])
            persona.save(shared, 'Client project role', [{**COOKING, 'body': 'Project menu.'}, {**COOKING, 'name': 'done-marks',
                         'description': 'When deciding whether a task is finished.', 'body': 'A green check means done.'}],
                         persona.view(shared)['revision'])
            turn = root / 'profiles' / Scopes.profile('-20:policy:3'); turn.mkdir(parents=True)
            persona.materialize(root, turn, '-20', project)
            value = persona.read(turn)
            self.assertEqual(value['role'], 'Client project role')
            self.assertEqual({s['name']: s['body'] for s in value['skills']}, {'weekly-menu': 'Project menu.', 'done-marks': 'A green check means done.'})
            persona.save(chat, 'Group role', [{**COOKING, 'body': 'Group menu.'}], persona.view(chat)['revision'])
            persona.materialize(root, turn, '-20', project)
            value = persona.read(turn)
            self.assertEqual(value['role'], 'Group role', 'the chat\'s own role wins')
            self.assertEqual({s['name']: s['body'] for s in value['skills']}, {'weekly-menu': 'Group menu.', 'done-marks': 'A green check means done.'})
            persona.materialize(root, turn, '-20')
            self.assertNotIn('done-marks', [s['name'] for s in persona.read(turn)['skills']], 'a chat outside the project never gets its skills')
            for bad in ('../profiles', 'A' * 64, ''):
                with self.assertRaisesRegex(ValueError, 'invalid_project'):
                    persona.project_path(root, bad)

    def test_other_chats_never_receive_a_groups_role_or_skills(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            persona.save(persona.chat_path(root, '-20'), 'Private group role', [COOKING],
                         persona.view(persona.chat_path(root, '-20'))['revision'])
            other = root / 'profiles' / Scopes.profile('-30:policy:1'); other.mkdir(parents=True)
            persona.materialize(root, other, '-30')
            self.assertEqual(persona.read(other), {'role': '', 'skills': []})
            self.assertEqual((other / 'SOUL.md').read_text(), '')

    def test_symlinked_role_or_skills_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chat = persona.chat_path(root, '-20'); chat.mkdir(parents=True)
            (root / 'secret').write_text('private')
            (chat / 'SOUL.md').symlink_to(root / 'secret')
            with self.assertRaisesRegex(ValueError, 'profile_path_denied'):persona.read(chat)


class PersonaTurnTests(unittest.TestCase):
    def test_turn_prompt_uses_the_chats_role_and_lists_its_skills_without_skill_writing(self):
        from contextvars import copy_context
        from hermes_state import SessionDB
        from run_agent import AIAgent
        from agent.system_prompt import build_system_prompt
        from tools.skills_tool import skill_view
        from .assistant_turn import OWNER_SET_TOOLS, bind_profile_home
        from .isolated_profile import database_path
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chat = persona.chat_path(root, '-20')
            persona.save(chat, 'You are the family cooking helper.', [COOKING], persona.view(chat)['revision'])
            turn = root / 'profiles' / Scopes.profile('-20:policy:2'); turn.mkdir(parents=True)
            persona.materialize(root, turn, '-20')
            (turn / 'native-state').mkdir()

            def build(bind):
                # A live turn keeps its session database in native-state/, as assistant_turn does.
                if bind: bind_profile_home(turn)
                agent = AIAgent(provider='openai', api_mode='chat_completions', model='synthetic', api_key='synthetic',
                                base_url='http://127.0.0.1:9/v1', enabled_toolsets=['skills'], fallback_model=None,
                                session_db=SessionDB(database_path(turn)), session_id='s',
                                platform='telegram', chat_id='-20', user_id='5', chat_type='group',
                                skip_context_files=True, load_soul_identity=True, skip_background_review=True,
                                quiet_mode=True, save_trajectories=False)
                agent.tools = [t for t in agent.tools if t['function']['name'] not in OWNER_SET_TOOLS]
                agent.valid_tool_names = set(agent.valid_tool_names) - OWNER_SET_TOOLS
                return agent, build_system_prompt(agent), skill_view('weekly-menu') if bind else None

            with patch.dict('os.environ', {'HERMES_HOME': str(turn)}):
                _, unbound, _ = copy_context().run(build, False)
                agent, prompt, viewed = copy_context().run(build, True)
            self.assertFalse(unbound.startswith('You are the family cooking helper.'),
                             'without a bound home Hermes looks beside the session database')
            self.assertTrue(prompt.startswith('You are the family cooking helper.'))
            self.assertIn('- weekly-menu: ' + COOKING['description'], prompt)
            self.assertEqual(agent.valid_tool_names, {'skills_list', 'skill_view'})
            self.assertIn(COOKING['body'], viewed)

    def test_a_role_or_skill_change_rebuilds_each_continuing_sessions_prompt_once(self):
        from contextvars import copy_context
        from hermes_state import SessionDB
        from run_agent import AIAgent
        from agent import conversation_loop
        from .assistant_turn import ALLOWED_TOOLS, OWNER_SET_TOOLS, bind_profile_home, install_tool_search_policy, verify_profile_tools
        from .isolated_profile import database_path
        self.addCleanup(install_tool_search_policy())
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            default, chat = persona.default_path(root), persona.chat_path(root, '-20')
            persona.save(chat, 'You are role A.', [COOKING], persona.view(chat)['revision'])
            turn = root / 'profiles' / Scopes.profile('-20:policy:2'); turn.mkdir(parents=True)
            (turn / 'native-state').mkdir()
            persona.materialize(root, turn, '-20')
            rebuilds = []

            def prompt(session):
                # What a turn's run_conversation sends: the session's stored prompt, or a new one it stores.
                def build():
                    bind_profile_home(turn)
                    database = SessionDB(database_path(turn))
                    continuing = database.get_session(session) is not None
                    if not continuing: database.create_session(session, source='telegram')
                    agent = AIAgent(provider='openai', api_mode='chat_completions', model='synthetic', api_key='synthetic',
                                    base_url='http://127.0.0.1:9/v1', enabled_toolsets=['memory', 'session_search', 'skills'],
                                    fallback_model=None, session_db=database, session_id=session, platform='telegram',
                                    chat_id='-20', user_id='5', chat_type='group', skip_context_files=True,
                                    load_soul_identity=True, skip_background_review=True, quiet_mode=True, save_trajectories=False)
                    agent.tools = [t for t in agent.tools if t['function']['name'] not in OWNER_SET_TOOLS]
                    agent.valid_tool_names = set(agent.valid_tool_names) - OWNER_SET_TOOLS
                    try:
                        conversation_loop._restore_or_build_system_prompt(
                            agent, None, [{'role': 'user', 'content': 'hello'}, {'role': 'assistant', 'content': 'hi'}] if continuing else [])
                        verify_profile_tools(agent.valid_tool_names, ALLOWED_TOOLS)
                        self.assertEqual(database.get_session(session)['system_prompt'], agent._cached_system_prompt)
                        return agent._cached_system_prompt, [t['function']['name'] for t in agent.tools]
                    finally: agent.close(); database.close()
                rebuild = conversation_loop.rebuild_for_refresh
                with patch.dict('os.environ', {'HERMES_HOME': str(turn)}), patch.object(
                        conversation_loop, 'rebuild_for_refresh', lambda agent, *rest: (rebuilds.append(agent.session_id), rebuild(agent, *rest))):
                    return copy_context().run(build)

            def epoch():
                database = SessionDB(database_path(turn))
                try: return database.prompt_refresh_epoch('s')
                finally: database.close()

            first, tools = prompt('s')
            self.assertTrue(first.startswith('You are role A.'))
            self.assertEqual(prompt('s'), (first, tools), 'a continuing session reuses its prompt and tools byte for byte')
            self.assertEqual(prompt('t')[0], first, 'another topic of the same profile')
            persona.save(chat, 'You are role B.', [COOKING, {**COOKING, 'name': 'groceries', 'body': 'List what is missing.'}],
                         persona.view(chat)['revision'])
            self.assertEqual(epoch(), 0, 'the owner\'s source folder has no sessions; the turn profile is not changed yet')
            persona.materialize(root, turn, '-20')
            persona.materialize(root, turn, '-20')
            self.assertEqual(epoch(), 1, 'Hermes is asked once, when the turn profile\'s files change')
            second, kept = prompt('s')
            self.assertTrue(second.startswith('You are role B.'))
            self.assertIn('- groceries: ', second)
            self.assertEqual(kept, tools, 'the session keeps its tools')
            self.assertEqual([prompt('s'), prompt('s')], [(second, tools)] * 2, 'later turns reuse the new prompt byte for byte')
            self.assertEqual(prompt('t')[0], second)
            self.assertEqual(prompt('t')[0], second)
            self.assertEqual(rebuilds, ['s', 't'], 'each session rebuilds once')
            persona.save(default, '', [{**COOKING, 'name': 'reminders', 'body': 'Remind the family.'}], persona.view(default)['revision'])
            persona.materialize(root, turn, '-20')
            self.assertIn('- reminders: ', prompt('s')[0], 'a change to the default reaches the chat\'s sessions too')
            self.assertEqual((epoch(), rebuilds), (2, ['s', 't', 's']))
            self.assertFalse(any(database_path(path).exists() for path in (default, chat)), 'a save never creates a session database')

    def test_a_save_into_a_profile_that_runs_turns_asks_hermes_to_refresh_its_prompts(self):
        from hermes_state import SessionDB
        from .isolated_profile import database_path
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chat = persona.chat_path(root, '-20'); (chat / 'native-state').mkdir(parents=True)
            database = SessionDB(database_path(chat))
            try:
                database.create_session('s', source='telegram')
                persona.save(chat, 'Group role', [], persona.view(chat)['revision'])
                self.assertEqual(database.prompt_refresh_epoch('s'), 1)
                persona.materialize(root, chat, '-20')
                self.assertEqual(database.prompt_refresh_epoch('s'), 1, 'a turn in the chat\'s own profile reads its files as saved')
            finally: database.close()

if __name__ == '__main__':
    unittest.main()
