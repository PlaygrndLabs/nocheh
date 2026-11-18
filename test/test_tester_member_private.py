"""The full tester's member private chat scenarios (step 4, step 4b, ADR-0262), checked without a fixture: the owner's
ask reaches the scripted model as one tool call whose question searches the member's chat, the reply rules are told
apart by words only one of them has, every run asks as people new to the fixture where a fixed reply comes once a day,
and the last sweep lets a member's marks show only in their own chat and in the one message that answered the
owner's ask."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.acceptance import canaries
from tools.acceptance.product_scenarios import ASK_TOOL, PRIVATE_DAILY_LIMIT, PRIVATE_NOT_ALLOWED, ProductScenarios
from tools.acceptance.telegram_scenarios import Fixture
from tools.paths import ROOT

OWNER, MEMBER, OTHER, GROUP = 123, 5000111, 5000222, -10042


def load():
    """The scripted model of the fixture (tools/acceptance/rehearsals/installation-provider.py)."""
    spec = importlib.util.spec_from_file_location('installation_provider', ROOT/'tools/acceptance/rehearsals/installation-provider.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
        spec.loader.exec_module(module)
    return module


def message(role, content):
    return SimpleNamespace(role=role, content=content)


def request(*messages, tools=()):
    return SimpleNamespace(messages=list(messages), tools=[{'type': 'function', 'function': {'name': name}} for name in tools],
                           stream=False, stream_options=None, model='fixture')


class KeptFixture:
    """A fixture kept between runs: its message ids keep counting, as Telegram's update ids do."""
    def __init__(self):
        self.next_id = 1000

    def ids(self):
        self.next_id += 10
        return self.next_id

    message = Fixture.message


class AskReachesTheModel(unittest.TestCase):
    def test_the_owners_ask_is_one_tool_call_and_its_question_searches_the_members_chat(self):
        brain = load().ScriptedBrain({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        text = ProductScenarios.ask_text('Synthetic 5000111', 'MEMBERWORD7')
        tools = ('mcp__nocheh__archive_search', ASK_TOOL)
        called = brain.respond(request(message('user', text), tools=tools))
        self.assertEqual(called, {'tool': ASK_TOOL, 'arguments': {'member': 'Synthetic 5000111',
                                                                  'question': 'What did they say about the locker? [[search:MEMBERWORD7]]'}})
        self.assertIn('Synthetic 5000111', text.split('[[tool:')[0], 'the owner\'s own words name the member')
        # The ask's own turn reads the question as its message.
        searched = brain.respond(request(message('user', called['arguments']['question']), tools=tools))
        self.assertEqual(searched, {'tool': 'mcp__nocheh__archive_search', 'arguments': {'mode': 'text', 'query': 'MEMBERWORD7', 'limit': 5}})


class RuleWords(unittest.TestCase):
    def test_a_stretch_only_one_rule_has_without_placeholders_or_brackets(self):
        member = 'You are in a member\'s own private chat with {name}.\nYou only read; you never post [anything] anywhere for them.'
        owner = 'You are in a member\'s own private chat with {name}.\nYou work for the owner.'
        words = ProductScenarios.rule_words(member, owner)
        self.assertTrue(words and words in member and words not in owner and not set(words) & set('[]{}'), words)
        self.assertIsNone(ProductScenarios.rule_words('short', owner))
        self.assertIsNone(ProductScenarios.rule_words(owner, owner))


class FreshPeople(unittest.TestCase):
    """A fixed reply comes once a UTC day per person: each run of a scenario that waits for one asks as someone new."""

    def fixed_replies(self, found, scenario):
        asked = []
        listed = lambda person: {'id': 'f6'*32, 'account_id': 'a7'*32, 'telegram_id': str(person), 'state': 'active', 'groups': [],
                                 'permissions': {'private_chat': True}}
        found.fixed_private_reply = lambda person, text, expected, label: asked.append((person, expected))
        found.turn = found.gate = found.wait = found.nothing_restarted = found.private_turn = found.remove_member = lambda *args, **kwargs: None
        found.service_starts = dict
        found.members_api = lambda path='', body=None, **kwargs: {'daily_messages': 200}
        found.add_member = lambda person, groups: listed(person)
        found.member_item = listed
        found.change_member = lambda item, groups=None, **changes: {**item, **({'state': changes['state']} if 'state' in changes else {}),
                                                                    'permissions': {'private_chat': changes.get('private_chat', True)}}
        getattr(found, scenario)()
        return asked

    def test_each_run_waits_for_its_fixed_replies_from_people_new_to_the_fixture(self):
        kept = KeptFixture()
        for scenario, expected in (('member_private_chat_off_or_paused_gets_fixed_reply', [PRIVATE_NOT_ALLOWED, PRIVATE_NOT_ALLOWED]),
                                   ('member_private_over_the_daily_cap', [PRIVATE_DAILY_LIMIT])):
            first, second = (self.fixed_replies(ProductScenarios(kept, None), scenario) for _ in range(2))
            with self.subTest(scenario):
                self.assertEqual([text for _, text in first], expected)
                self.assertEqual(len({person for person, _ in first+second}), 2*len(expected), 'nobody is asked twice')


class SweepFixture:
    def __init__(self, directory, state):
        self.directory, self.state = directory, state

    def telegram(self):
        return self.state


def sent(chat, text, number):
    return {'parameters': {'chat_id': str(chat), 'text': text}, 'message': {'message_id': number, 'chat': {'id': chat}, 'text': text}}


class LastSweep(unittest.TestCase):
    def sweep(self, rows):
        with tempfile.TemporaryDirectory() as folder:
            canaries.save(folder, {'PRIVATEMARK1': 'private chat message'}, OWNER)
            canaries.save(folder, {'MEMBERMARK1said': 'member private message'}, OWNER, home=MEMBER)
            canaries.save(folder, {'MEMBERMARK1other': "another member's private message"}, OWNER, home=OTHER)
            canaries.shown(folder, ['MEMBERMARK1said'], OWNER, [2002])
            found = ProductScenarios(SweepFixture(Path(folder), {'sent': rows, 'presses': [], 'answers': [], 'calls': []}), Path(folder))
            found.execute('private_canaries_never_left_the_owner', found.private_canaries_never_left_the_owner)
            return found.results[-1]

    def home_rows(self):
        return [sent(OWNER, 'Your note PRIVATEMARK1', 2001), sent(MEMBER, 'You said MEMBERMARK1said', 3001),
                sent(OTHER, 'You said MEMBERMARK1other', 3002), sent(OWNER, 'In their chat: MEMBERMARK1said', 2002)]

    def test_marks_in_their_homes_and_the_asks_answer_pass(self):
        result = self.sweep(self.home_rows())
        self.assertTrue(result['passed'], result.get('failed_gate'))

    def test_a_member_mark_in_a_later_owner_message_another_members_chat_or_a_group_fails(self):
        for row in (sent(OWNER, 'Earlier you asked: MEMBERMARK1said', 2003), sent(OTHER, 'MEMBERMARK1said', 3003),
                    sent(GROUP, 'MEMBERMARK1other', 4001), sent(MEMBER, 'PRIVATEMARK1', 3004)):
            with self.subTest(row['message']['text']):
                result = self.sweep(self.home_rows()+[row])
                self.assertFalse(result['passed'])
                self.assertEqual(result['failed_gate']['gate'], 'no_private_mark_outside_its_own_chat')

    def test_a_member_whose_marks_were_never_seen_at_home_fails(self):
        result = self.sweep([row for row in self.home_rows() if row['message']['chat']['id'] != OTHER])
        self.assertEqual(result['failed_gate']['gate'], 'member_marks_seen_in_their_own_chat')
        self.assertEqual(json.loads(json.dumps(result['failed_gate']))['homes'], 2)


if __name__ == '__main__':
    unittest.main()
