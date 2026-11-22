"""The full tester's member private chat scenarios (step 4, step 4b, ADR-0262), checked without a fixture: the owner's
ask reaches the scripted model as one tool call whose question searches the member's chat, the reply rules are told
apart by words only one of them has, every run asks as people new to the fixture where a fixed reply comes once a day,
and the last sweep lets a member's marks show only in their own chat and in the one message that answered the
owner's ask."""
import contextlib
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
        agent = load().ScriptedAgent({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        text = ProductScenarios.ask_text('Synthetic 5000111', 'MEMBERWORD7')
        tools = ('mcp__nocheh__archive_search', ASK_TOOL)
        called = agent.respond(request(message('user', text), tools=tools))
        self.assertEqual(called, {'tool': ASK_TOOL, 'arguments': {'member': 'Synthetic 5000111',
                                                                  'question': 'What did they say about the locker? [[search:MEMBERWORD7]]'}})
        self.assertIn('Synthetic 5000111', text.split('[[tool:')[0], 'the owner\'s own words name the member')
        # The ask's own turn reads the question as its message.
        searched = agent.respond(request(message('user', called['arguments']['question']), tools=tools))
        self.assertEqual(searched, {'tool': 'mcp__nocheh__archive_search', 'arguments': {'mode': 'text', 'query': 'MEMBERWORD7', 'limit': 5}})

    def test_the_asking_turn_answers_so_it_ends_done_before_the_ask_runs(self):
        agent = load().ScriptedAgent({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        asked = message('user', ProductScenarios.ask_text('Synthetic 5000111', 'MEMBERWORD7'))
        answer = agent.respond(request(asked, message('assistant', None), message('tool', '{"queued":true,"id":"a1"}'), tools=(ASK_TOOL,)))
        self.assertEqual(answer, {'content': '[agent] '+ASK_TOOL+': {"queued":true,"id":"a1"}'}, 'never [NO_REPLY], which closes it suppressed')


class RecheckSearches(unittest.TestCase):
    def test_the_rechecks_searches_send_no_reply_that_a_later_search_could_find(self):
        # A reply quoting the hits stays in the member's chat, which they read whole: a group's mark would still be found
        # there after the group is no longer read.
        found, turns, agent = ProductScenarios(KeptFixture(), None), [], load().ScriptedAgent({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        found.current = {}
        found.f.sent = list
        found.f.chat = lambda chat: 'telegram:'+str(chat)
        found.f.control = found.age_presence = found.said_in_group = found.remove_member = lambda *args: None
        found.f.telegram = lambda: {'faults': []}
        found.f.agent = lambda: [{'tool': 'mcp__nocheh__archive_search', 'phase': 'final', 'argument': turns[-1][0].split('[[search:')[1].split(']]')[0],
                                  'result': 'hits'}]
        found.gate = found.wait = lambda *args, **kwargs: None
        found.fresh_person = lambda: MEMBER
        found.add_member = lambda person, groups: {'id': 'm1'}
        found.member_checks = lambda person, group: len(turns)
        found.presence_row = lambda person, group: {'state': 'in', 'source': 'checked', 'fresh': True}

        def answered(update, chat, *args, **kwargs):
            text = update['message']['text']
            turns.append((text, agent.respond(request(message('user', text), message('assistant', None), message('tool', '{"hits":[]}'),
                                                      tools=('mcp__nocheh__archive_search',)))['content']))
            return 'event', ''
        found.turn = found.silent_turn = answered
        found.member_private_chat_rechecks_old_presence()
        self.assertEqual(len(turns), 5)
        self.assertEqual({answer for _, answer in turns}, {'[NO_REPLY]'})


class MemberTasks(unittest.TestCase):
    def test_adding_a_task_from_a_members_chat_expects_the_mcp_servers_refusal(self):
        # Nocheh's MCP server answers a member's private turn {"error":"tool_unavailable"} for any tasks action but list
        # and get, before storage sees it (src/mcp/server.ts, test/private-answers.test.ts).
        found, gates = ProductScenarios(KeptFixture(), None), {}
        found.current = {}
        found.f.chat, found.f.sent = (lambda chat: 'telegram:'+str(chat)), list
        found.gate = lambda label, value=True, **observed: gates.setdefault(label, bool(value))
        found.fresh_person = lambda: MEMBER
        found.add_member = lambda person, groups: {'id': 'm1'}
        found.new_group_chat = found.remove_member = found.said_in_group = found.turn = found.silent_turn = lambda *args, **kwargs: None
        found.private_search = lambda person, word: ''
        found.tool_final = lambda *args: None
        found.approval_cards = lambda before: []
        found.groups_in_projects = contextlib.contextmanager(lambda layout: (yield {name: {'id': 'p'+str(index)} for index, name in enumerate(layout)}))
        found.task_tool = lambda arguments, chat=OWNER, topic=None, sender=OWNER: (
            {'error': 'tool_unavailable'} if sender != OWNER and arguments['action'] not in ('list', 'get') else {})
        with patch('tools.acceptance.product_scenarios.time.sleep'):
            found.member_private_chat_reads_joined_groups()
        self.assertIs(gates.get('adding_a_task_is_refused'), True)


class OwnerChat:
    """The owner's private chat as the scripted model sees it: each turn's request holds every earlier owner message and
    answer, as the owner's Hermes session keeps them, but never the separate answer to an ask. Its replies are sent."""
    TOOLS = ('mcp__nocheh__archive_search', 'mcp__nocheh__memory_recall', 'mcp__nocheh__owner_read', ASK_TOOL)

    def __init__(self, sent):
        self.agent = load().ScriptedAgent({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        self.history, self.sent = [], sent

    def say(self, text):
        current = message('user', text)
        answer = self.agent.respond(request(*self.history, current, tools=self.TOOLS))
        if 'tool' in answer:
            result = '{"queued":true}' if answer['tool'] == ASK_TOOL else '{}'
            answer = self.agent.respond(request(*self.history, current, message('assistant', None), message('tool', result), tools=self.TOOLS))
        self.history += [current, message('assistant', answer['content'])]
        if answer['content'] != '[NO_REPLY]':
            self.sent.append(sent(OWNER, answer['content'], 2000+len(self.sent)))
        return answer['content']


class OwnerProbes(unittest.TestCase):
    """The owner's context probes in member_private_chat_stays_with_the_member and owner_asks_about_a_member, run against
    the scripted model with an owner chat that keeps its history: with nothing leaked, no probe finds a member's mark
    present only because an earlier owner message named it, and no probe's answer is a leak in the last sweep."""

    def run_both(self, folder):
        fixture, rows, people, gates = KeptFixture(), [], iter(range(5000300, 5000400)), {}
        fixture.directory, fixture.sent = Path(folder), lambda: rows
        owner = OwnerChat(rows)
        events = [{'tool': name, 'phase': 'final', 'result': '', 'argument': None}
                  for name in ('mcp__nocheh__archive_search', 'mcp__nocheh__memory_recall')]
        fixture.agent = lambda: events
        fixture.query = lambda *args: '0'
        fixture.conversations = list

        def say(update):
            reply = owner.say(update['message']['text'])
            if ASK_TOOL in update['message']['text']:
                # The ask's separate answer quotes the member's chat; the owner's session never keeps it.
                planted = found.member_canary
                rows.append(sent(OWNER, 'From their chat:\n\n[agent] mcp__nocheh__archive_search: '+planted['said']+' '+planted.get('kept', ''), 2900))
                events.append({'tool': 'mcp__nocheh__archive_search', 'phase': 'final', 'argument': planted['word'], 'result': planted['said']})
            return reply
        fixture.inject = say

        found = ProductScenarios(fixture, Path(folder))
        found.current = {}
        found.gate = lambda label, value=True, **observed: gates.setdefault(label, bool(value))
        found.wait = lambda label, check, *args: check()
        found.fresh_person = lambda: next(people)
        found.add_member = lambda person, groups: {'id': 'm'+str(person), 'name': 'Synthetic '+str(person)}
        found.private_turn = lambda person, text: ('event', text)
        found.private_search = lambda person, word: '\n'.join(mark for mark, place in canaries.load(folder).get('homes', {}).items()
                                                              if place['home'] == person)
        found.plant_profiles = lambda *args: {'member': True, 'ask': 'nocheh-'+'a'*24}
        found.honcho = lambda *args: '0'
        found.memory_settled = found.remove_profile = found.remove_member = lambda *args: None
        found.owner_side_holds_none = lambda marks: {}
        found.newest_tool_result = lambda name: {}
        found.newest_tool_result_text = lambda name: '{"queued":true}' if name == ASK_TOOL else ''
        found.captured = lambda update: 'event'
        found.finished = lambda event: {'state': 'done', 'error': None}
        found.is_card = lambda row: False

        def turn(update, chat, topic=None, expect_reply=True, **kwargs):
            return 'event', say(update) if chat == OWNER else '[agent] ok'
        found.turn = turn
        found.silent_turn = lambda update, chat, topic=None: (say(update) if chat == OWNER else None, len(rows))
        canaries.save(folder, {'PRIVATEMARK1': 'private chat message'}, OWNER)
        found.member_private_chat_stays_with_the_member()
        found.owner_asks_about_a_member()
        return gates, rows, owner

    def test_no_owner_message_makes_a_probe_present_and_no_probe_answer_is_a_leak(self):
        with tempfile.TemporaryDirectory() as folder:
            gates, rows, owner = self.run_both(folder)
            for label in ('member_marks_never_left_the_members_side', 'asking_turn_done', 'ask_queued',
                          'answer_holds_the_mark_the_owner_never_named', 'answer_dropped_from_the_next_turn'):
                self.assertIs(gates.get(label), True, label)
            planted = canaries.load(folder)
            members = [mark for mark in planted['marks'] if mark.startswith('MEMBERMARK') and not mark.endswith('other')]
            probes = [item.content for item in owner.history if item.role == 'user' and 'context' in item.content]
            self.assertEqual(len(probes), len(members) + 1, 'each mark once, and the mark the ask answered after it')
            self.assertEqual(canaries.leaks({'sent': rows}, set(planted['marks']), OWNER, canaries.places(planted)), [])


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
