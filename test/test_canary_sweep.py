"""The full tester's canary sweep finds a private mark anywhere the fake Telegram sent it outside the owner's chat."""
import json
import tempfile
import unittest
from pathlib import Path

from tools.acceptance import canaries

OWNER, GROUP, MEMBER = 123, -1001000000001, 778
MARKS = {'PRIVATEMARK12': 'private chat message', 'PRIVATEMARK13': 'native note'}


def sent(chat, text, number, buttons=None, edits=()):
    parameters = {'chat_id': str(chat), 'text': text}
    message = {'message_id': number, 'chat': {'id': chat, 'type': 'private' if chat > 0 else 'supergroup'}, 'text': text}
    if buttons:
        parameters['reply_markup'] = json.dumps({'inline_keyboard': [[{'text': label, 'callback_data': 'na'+str(number)} for label in buttons]]})
        message['reply_markup'] = json.loads(parameters['reply_markup'])
    row = {'parameters': parameters, 'message': message}
    if edits:
        row['edits'] = [{'parameters': {'chat_id': str(chat), 'message_id': str(number), 'text': text}, 'at': 1.0} for text in edits]
    return row


def press(identifier, presser, chat):
    return {'update_id': identifier, 'callback_query': {'id': 'cb'+str(identifier), 'from': {'id': presser}, 'data': 'na1',
                                                        'message': {'message_id': 1, 'chat': {'id': chat}}}}


def state(**parts):
    return {'sent': [], 'presses': [], 'answers': [], 'calls': [], **parts}


class LeakTests(unittest.TestCase):
    def test_a_mark_in_a_group_message_an_edit_a_button_or_a_members_press_answer_is_a_leak(self):
        cases = {
            'message': state(sent=[sent(GROUP, 'The owner said PRIVATEMARK12', 1001)]),
            'edit': state(sent=[sent(GROUP, 'Working on it', 1002, edits=['Done: PRIVATEMARK13'])]),
            'button': state(sent=[sent(GROUP, 'Pick one', 1003, buttons=['Open PRIVATEMARK12'])]),
            'answer': state(presses=[press(5, MEMBER, GROUP)], answers=[{'callback_query_id': 'cb5', 'text': 'Only for PRIVATEMARK13'}]),
            'member chat': state(sent=[sent(MEMBER, 'PRIVATEMARK12', 1004)]),
        }
        for name, value in cases.items():
            with self.subTest(name):
                found = canaries.leaks(value, MARKS, OWNER)
                self.assertTrue(found, name)
                self.assertTrue(all(hit['chat'] != OWNER for hit in found))
        self.assertEqual([(hit['where'], hit['mark']) for hit in canaries.leaks(cases['edit'], MARKS, OWNER)], [('edit', 'PRIVATEMARK13')])
        self.assertEqual(canaries.leaks(cases['answer'], MARKS, OWNER), [{'where': 'answer', 'chat': MEMBER, 'mark': 'PRIVATEMARK13'}])

    def test_the_owner_chat_and_the_owners_own_press_answers_stay_out_of_the_sweep(self):
        value = state(sent=[sent(OWNER, 'Your note: PRIVATEMARK13', 1001, buttons=['Approve PRIVATEMARK12'], edits=['Approved PRIVATEMARK12'])],
                      presses=[press(6, OWNER, GROUP)], answers=[{'callback_query_id': 'cb6', 'text': 'Approved PRIVATEMARK12'}],
                      calls=[{'method': 'sendMessage', 'parameters': {'chat_id': str(OWNER), 'text': 'PRIVATEMARK12'}, 'at': 1.0}])
        self.assertEqual(canaries.leaks(value, MARKS, OWNER), [])
        self.assertEqual({hit['where'] for hit in canaries.leaks(value, MARKS, None)}, {'message', 'edit', 'answer', 'call'},
                         'with no owner every chat counts, so the sweep can show the marks reached the owner')

    def test_an_answer_privately_button_is_no_leak_but_a_mark_in_a_members_popup_link_is(self):
        reply = sent(GROUP, 'Your plan', 1005)
        reply['parameters']['reply_markup'] = json.dumps({'inline_keyboard': [[{'text': 'Answer privately', 'callback_data': 'np'+'a'*32}]]})
        reply['message']['reply_markup'] = json.loads(reply['parameters']['reply_markup'])
        self.assertEqual(canaries.leaks(state(sent=[reply], presses=[press(7, OWNER, GROUP)],
                                              answers=[{'callback_query_id': 'cb7', 'text': 'Opening', 'url': 'https://t.me/synthetic_fixture_bot?start='+'a'*32}]),
                                        MARKS, OWNER), [])
        leaked = state(presses=[press(8, MEMBER, GROUP)], answers=[{'callback_query_id': 'cb8', 'text': 'Opening', 'url': 'https://t.me/x?start=PRIVATEMARK12'}])
        self.assertEqual(canaries.leaks(leaked, MARKS, OWNER), [{'where': 'answer', 'chat': MEMBER, 'mark': 'PRIVATEMARK12'}])

    def test_refused_sends_and_menus_everyone_sees_are_in_the_call_log(self):
        refused = {'method': 'sendMessage', 'parameters': {'chat_id': str(GROUP), 'text': 'PRIVATEMARK12'}, 'status': 400}
        menu = {'method': 'setMyCommands', 'parameters': {'commands': json.dumps([{'command': 'x', 'description': 'PRIVATEMARK13'}])}}
        owner_menu = {'method': 'setMyCommands', 'parameters': {'scope': json.dumps({'type': 'chat', 'chat_id': OWNER}),
                                                                'commands': [{'command': 'x', 'description': 'PRIVATEMARK13'}]}}
        found = canaries.leaks(state(calls=[refused, menu, owner_menu]), MARKS, OWNER)
        self.assertEqual([(hit['method'], hit['chat'], hit['mark']) for hit in found],
                         [('sendMessage', GROUP, 'PRIVATEMARK12'), ('setMyCommands', None, 'PRIVATEMARK13')])

    def test_a_longer_number_is_another_mark(self):
        value = state(sent=[sent(GROUP, 'PRIVATEMARK123 and PRIVATEMARK1', 1001)])
        self.assertEqual(canaries.leaks(value, MARKS, OWNER), [])
        self.assertEqual(canaries.found('PRIVATEMARK12. PRIVATEMARK123', MARKS), ['PRIVATEMARK12'])
        with self.assertRaises(ValueError):
            canaries.found('anything', {})


class MemberHomeTests(unittest.TestCase):
    """A MEMBERMARK lives in its member's own private chat (step 4): it may show there and, after the owner asks about
    that member (step 4b), in the one separate message that answers the ask, and nowhere else, the owner's chat
    included."""
    OTHER = 779
    MARK = {'MEMBERMARK21': 'member private message'}

    def planted(self, folder, answers=()):
        canaries.save(folder, {'PRIVATEMARK12': 'private chat message'}, OWNER)
        canaries.save(folder, self.MARK, OWNER, home=MEMBER)
        if answers:
            canaries.shown(folder, self.MARK, OWNER, answers)
        planted = canaries.load(folder)
        return planted, canaries.places(planted)

    def test_a_member_mark_is_swept_everywhere_but_its_own_chat(self):
        with tempfile.TemporaryDirectory() as folder:
            planted, where = self.planted(folder)
            self.assertEqual(where['MEMBERMARK21'], {'home': MEMBER, 'chats': {MEMBER}, 'messages': set()})
            self.assertEqual(where['PRIVATEMARK12'], {'home': OWNER, 'chats': {OWNER}, 'messages': set()})
            value = state(sent=[sent(MEMBER, 'You said MEMBERMARK21', 1001), sent(OWNER, 'Your note PRIVATEMARK12', 1002),
                                sent(OWNER, 'Mira said MEMBERMARK21', 1003), sent(self.OTHER, 'MEMBERMARK21', 1004),
                                sent(GROUP, 'MEMBERMARK21', 1005), sent(MEMBER, 'The owner said PRIVATEMARK12', 1006)])
            found = canaries.leaks(value, planted['marks'], OWNER, where)
            self.assertEqual(sorted((hit['chat'], hit['mark']) for hit in found),
                             sorted([(OWNER, 'MEMBERMARK21'), (self.OTHER, 'MEMBERMARK21'), (GROUP, 'MEMBERMARK21'), (MEMBER, 'PRIVATEMARK12')]))

    def test_the_answer_to_the_owners_ask_may_quote_it_but_no_later_owner_message(self):
        with tempfile.TemporaryDirectory() as folder:
            planted, where = self.planted(folder, answers=[1003])
            answer, later = sent(OWNER, 'In their chat: MEMBERMARK21', 1003, edits=['In their chat: MEMBERMARK21 (edited)']), sent(OWNER, 'Earlier: MEMBERMARK21', 1004)
            calls = [{'method': 'sendMessage', 'parameters': answer['parameters']},
                     {'method': 'editMessageText', 'parameters': answer['edits'][0]['parameters']},
                     {'method': 'sendMessage', 'parameters': later['parameters']}]
            found = canaries.leaks(state(sent=[answer, later], calls=calls), planted['marks'], OWNER, where)
            self.assertEqual([(hit['where'], hit.get('message_id')) for hit in found], [('message', 1004), ('call', None)])
            self.assertEqual(where['MEMBERMARK21']['messages'], {(OWNER, 1003)})

    def test_a_members_own_press_answer_is_theirs_and_another_members_is_a_leak(self):
        with tempfile.TemporaryDirectory() as folder:
            planted, where = self.planted(folder)
            value = state(presses=[press(9, MEMBER, MEMBER), press(10, self.OTHER, self.OTHER)],
                          answers=[{'callback_query_id': 'cb9', 'text': 'MEMBERMARK21'}, {'callback_query_id': 'cb10', 'text': 'MEMBERMARK21'}])
            self.assertEqual(canaries.leaks(value, planted['marks'], OWNER, where), [{'where': 'answer', 'chat': self.OTHER, 'mark': 'MEMBERMARK21'}])

    def test_a_mark_shown_must_be_saved_and_the_saved_places_must_be_whole(self):
        with tempfile.TemporaryDirectory() as folder:
            self.planted(folder)
            with self.assertRaises(ValueError):
                canaries.shown(folder, {'MEMBERMARK99': 'never planted'}, OWNER, [1])
            path = Path(folder)/canaries.FILE
            value = json.loads(path.read_text())
            value['homes']['MEMBERMARK21'] = {'home': str(MEMBER), 'allowed': []}
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                canaries.load(folder)


class SavedMarksTests(unittest.TestCase):
    def test_the_sweep_fails_without_saved_marks(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                canaries.load(folder)
            (Path(folder)/canaries.FILE).write_text(json.dumps({'owner': OWNER, 'marks': {}}))
            with self.assertRaises(ValueError):
                canaries.load(folder)

    def test_marks_add_up_across_runs_for_one_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            canaries.save(folder, {'PRIVATEMARK12': 'private chat message'}, OWNER)
            canaries.save(folder, {'PRIVATEMARK13': 'native note'}, OWNER)
            self.assertEqual(canaries.load(folder), {'owner': OWNER, 'marks': MARKS})
            self.assertEqual((Path(folder)/canaries.FILE).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                canaries.save(folder, {'PRIVATEMARK14': 'personal task'}, 124)


class MemberAppSweepTests(unittest.TestCase):
    """The members' app (ADR-0265) reads no chat, so any mark in any of its answers is a leak, a member's own included;
    the reminders in members' own chats are swept for the app's marks and for people's Telegram names."""
    MARKS = {'MEMBERMARK7said', 'PRIVATEMARK12', 'OTHERPROJECTMARK9', 'OWNERNAMEMARK9'}

    def test_any_mark_in_any_answer_is_a_leak_and_a_clean_answer_is_not(self):
        responses = [{'user': MEMBER, 'method': 'GET', 'path': '/tasks', 'status': 200, 'body': json.dumps({'tasks': [{'title': 'Seen APPSEEN9'}]})},
                     {'user': MEMBER, 'method': 'GET', 'path': '/me', 'status': 200, 'body': '{"name":"MEMBERMARK7said"}'},
                     {'user': MEMBER, 'method': 'GET', 'path': '/tasks/x', 'status': 404, 'body': {'error': 'OTHERPROJECTMARK9'}},
                     {'user': 779, 'method': 'GET', 'path': '/me', 'status': 200, 'body': 'OTHERPROJECTMARK91 is another mark'}]
        hits = canaries.leaks_http(responses, self.MARKS)
        self.assertEqual([(hit['path'], hit['mark']) for hit in hits], [('/me', 'MEMBERMARK7said'), ('/tasks/x', 'OTHERPROJECTMARK9')])
        self.assertEqual(canaries.leaks_http(responses[:1], self.MARKS), [])

    def test_answers_and_marks_are_kept_and_never_pass_on_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(FileNotFoundError, 'member_app_responses_missing'):
                canaries.load_http(folder)
            with self.assertRaisesRegex(FileNotFoundError, 'member_app_marks_missing'):
                canaries.load_app_marks(folder)
            canaries.log_http(folder, {'user': MEMBER, 'path': '/me', 'status': 200, 'body': '{}'})
            canaries.log_http(folder, {'user': MEMBER, 'path': '/tasks', 'status': 200, 'body': '{"tasks":[]}'})
            self.assertEqual([row['path'] for row in canaries.load_http(folder)], ['/me', '/tasks'])
            self.assertEqual(oct((Path(folder)/canaries.HTTP_FILE).stat().st_mode & 0o777), '0o600')
            canaries.save_app_marks(folder, {'OTHERPROJECTMARK9': 'another project\'s task'}, {'APPSEEN9': 'GP1 task'})
            value = canaries.save_app_marks(folder, {'PREJOINMARK9': 'comment'}, {})
            self.assertEqual(value, canaries.load_app_marks(folder))
            self.assertEqual(set(value['hidden']), {'OTHERPROJECTMARK9', 'PREJOINMARK9'})
            with self.assertRaisesRegex(ValueError, 'member_app_marks_overlap'):
                canaries.save_app_marks(folder, {'APPSEEN9': 'now hidden'}, {})

    def test_reminders_in_members_chats_are_swept_on_what_they_read(self):
        reminder = sent(MEMBER, '\u23f0 Pack the tent\n\U0001f4c1 App P1\n\n\U0001f464 Set by you', 41)
        reminder['message']['from'] = {'id': 123456, 'is_bot': True, 'first_name': 'Synthetic'}
        leaked = sent(779, '\u23f0 OTHERPROJECTMARK9 tent\n\U0001f464 Set by you', 42, edits=('\u23f0 tent, as Synthetic 778 said',))
        other = [sent(MEMBER, 'A private reply that names OTHERPROJECTMARK9', 43), sent(OWNER, '\u23f0 OTHERPROJECTMARK9 for you', 44), sent(GROUP, '\u23f0 OTHERPROJECTMARK9', 45)]
        found = canaries.leaks_reminders(state(sent=[reminder, leaked, *other]), self.MARKS | {'Synthetic'}, OWNER)
        self.assertEqual(sorted((hit['message_id'], hit['mark']) for hit in found), [(42, 'OTHERPROJECTMARK9'), (42, 'Synthetic')])
        self.assertEqual([row['message']['message_id'] for row in canaries.member_reminders(state(sent=[reminder, leaked, *other]), OWNER)], [41, 42])

    def test_app_sweep_runs_after_every_app_scenario_next_to_the_private_sweep(self):
        from tools.acceptance.full_test import TITLES
        from tools.acceptance.product_scenarios import PRODUCT_ORDER, ProductScenarios
        app = [name for name in PRODUCT_ORDER if name.startswith('member_app_') or name in ('owner_mini_app_still_works', 'menu_button_on_apply')]
        self.assertEqual(app[-1], 'member_app_never_leaks')
        self.assertEqual(PRODUCT_ORDER.index('member_app_never_leaks')+1, PRODUCT_ORDER.index('private_canaries_never_left_the_owner'))
        self.assertLess(PRODUCT_ORDER.index('member_reminder_says_who_set_it'), PRODUCT_ORDER.index('member_app_never_leaks'))
        self.assertTrue(all(hasattr(ProductScenarios, name) and name in TITLES for name in app))


if __name__ == '__main__':
    unittest.main()
