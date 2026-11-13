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


if __name__ == '__main__':
    unittest.main()
