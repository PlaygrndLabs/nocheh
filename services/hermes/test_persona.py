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

    def test_a_continuing_session_rebuilds_its_prompt_after_the_role_or_skills_change(self):
        from hermes_state import SessionDB
        from .isolated_profile import database_path
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chat = persona.chat_path(root, '-20')
            turn = root / 'profiles' / Scopes.profile('-20:policy:2'); turn.mkdir(parents=True)
            (turn / 'native-state').mkdir()
            persona.materialize(root, turn, '-20')
            database = SessionDB(database_path(turn))
            database.create_session('s', source='telegram')
            database.update_system_prompt('s', 'Prompt built before any role')
            database.update_session_tool_names('s', ['memory'])
            stored = lambda: (database.get_session('s').get('system_prompt'), database.get_session('s').get('tool_names'))
            self.assertTrue(persona.refresh_prompt(turn, database, 's'), 'a session never checked is rebuilt once')
            self.assertEqual(stored(), (None, None))
            database.update_system_prompt('s', 'Prompt with the current role')
            self.assertFalse(persona.refresh_prompt(turn, database, 's'))
            self.assertEqual(stored()[0], 'Prompt with the current role')
            persona.save(chat, 'Group role', [COOKING], persona.view(chat)['revision'])
            persona.materialize(root, turn, '-20')
            self.assertTrue(persona.refresh_prompt(turn, database, 's'))
            self.assertEqual(stored()[0], None)
            self.assertFalse(persona.refresh_prompt(turn, database, 'new-session'), 'a new session builds its own prompt')

if __name__ == '__main__':
    unittest.main()
