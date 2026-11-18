"""The full tester's source tag scenarios (tools/acceptance/product_scenarios.py, ADR-0261) pass on a product that names
each hit's source, opens a message with its thread and forgets a retired message at once, and fail on one that does
what Nocheh did before step 1, or that lets a tag say more than its reader may know.

Each scenario runs here against a made-up installation: an archive of the messages the scenario sends, tags built the
way Nocheh's code words them, stored chat history with the recent block a group turn carries, native notes and recall.
A `fault` makes it behave like the old product or like a leak."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.acceptance.product_scenarios import GUEST, MEMBER, TEAM_TOPIC, ProductScenarios
from tools.acceptance.telegram_scenarios import GROUP, OTHER_GROUP, OWNER, Failed, Fixture
from tools.paths import ROOT

TIME, AT = '2026-11-17 10:00', '2026-11-17T10:00:00.000Z'


def provider():
    spec = importlib.util.spec_from_file_location('installation_provider', ROOT/'tools/acceptance/rehearsals/installation-provider.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
        spec.loader.exec_module(module)
    return module


BRAIN = provider().ScriptedBrain


class Installation(Fixture):
    """The fake Telegram, the archive and the brain's tools of a made-up installation, as the scenarios read them.

    Faults: `untagged` (hits and opened messages as before ADR-0261), `owner_zone_everywhere`, `owner_word_in_groups`,
    `owner_topic_name_leaks`, `outside_reply_in_group`, `evidence_dropped` (sibling topic evidence lost, V2),
    `session_text_empty` (V1), `session_context` (neighbour rows in hits), `history_kept` (B6.1 not applied), `turn_kept`
    (recall skips the quoting rows but the next turn still reads them), `note_kept`."""

    def __init__(self, directory, fault=None):
        self.directory, self.next_id, self.fault = directory, 1794900000, fault
        self.events, self.messages, self.retired, self.zone = [], [], set(), 'UTC'
        self.topics = {(GROUP, TEAM_TOPIC): ('Team plans', 'observed')}
        self.history, self.notes, self.quiet = {}, [], {}

    # The fake Telegram and the owner's API ---------------------------------------------------------------------------

    def ids(self):
        self.next_id += 10
        return self.next_id

    def brain(self):
        return self.events

    def app(self, path, body=None, allow_error=False):
        if path == '/v1/tasks/settings':
            if body is not None:
                self.zone = body['time_zone']
            return {'time_zone': self.zone, 'revision': '1'}
        if path == '/v1/telegram/topics':
            key = (int(body['chat_id']), int(body['topic_id']))
            if body['action'] == 'add':
                self.topics[key] = (body['name'], 'owner')
            else:
                self.topics.pop(key, None)
            return {}
        found = re.fullmatch(r'/v1/sources/([a-f0-9]{64})/retirement', path)
        if found:
            if body is not None and body.get('retired'):
                self.retired.add(found[1])
            return {'retired': found[1] in self.retired, 'revision': 1 if found[1] in self.retired else 0}
        raise AssertionError('unexpected route '+path)

    # The archive ------------------------------------------------------------------------------------------------------

    def archive(self, update):
        message = update['message']
        event_id = hashlib.sha256(str(update['update_id']).encode()).hexdigest()
        target = (message.get('reply_to_message') or {}).get('message_id')
        outside = message.get('external_reply') or {}
        row = {'id': event_id, 'chat': message['chat']['id'], 'topic': message.get('message_thread_id'), 'number': message['message_id'],
               'sender': message['from']['id'], 'name': message['from'].get('first_name'), 'username': message['from'].get('username'),
               'text': message.get('text') or '', 'addressed': bool(message.get('entities')) or message['chat']['id'] > 0,
               'reply_to': next((item['id'] for item in self.messages if target and item['number'] == target and item['chat'] == message['chat']['id']), None),
               'outside_to': next((item['id'] for item in self.messages if outside and item['number'] == outside['message_id']
                                   and item['chat'] == outside['chat']['id']), None)}
        self.messages.append(row)
        return row

    def message_of(self, event_id):
        return next((item for item in self.messages if item['id'] == event_id), None)

    @staticmethod
    def owner_reader(reader):
        return reader[0] == OWNER

    def readable(self, reader, row):
        """The owner reads everything; a group reads its own chat, every topic of it (its topics share memory)."""
        return row is not None and row['id'] not in self.retired and (self.owner_reader(reader) or row['chat'] == reader[0])

    def place(self, reader, chat, topic):
        if (chat, topic) == reader:
            return 'this chat'
        if chat == OWNER:
            return 'your private chat'
        name, source = self.topics.get((chat, topic), (None, None))
        shown = name if name and (self.owner_reader(reader) or source == 'observed' or self.fault == 'owner_topic_name_leaks') else None
        return 'group “Synthetic Forum '+str(chat)+'”'+('' if topic is None else ' › topic “'+shown+'”' if shown else ' › a topic')

    def tag(self, reader, row):
        owner = self.owner_reader(reader)
        if row['sender'] == OWNER and (owner or self.fault == 'owner_word_in_groups'):
            who = 'the owner'
        else:
            who = '“'+row['name']+'”'+(' (@'+row['username']+')' if row['username'] else '')
        zone = self.zone if owner or self.fault == 'owner_zone_everywhere' else 'UTC'
        return {'tag': who+' · '+self.place(reader, row['chat'], row['topic'])+' · '+TIME+' '+zone, 'by': 'owner' if row['sender'] == OWNER else 'person', 'at': AT}

    def hit(self, reader, row):
        hit = {'id': row['id'], 'source': 'nocheh:event:'+row['id'], 'scope': str(row['chat']), 'source_id': str(row['number']), 'revision': '1',
               'kind': 'telegram_update', 'origin': 'live', 'occurred_at': '1794900000', 'chat_id': str(row['chat']), 'representation': 'guarded',
               'derived_id': None, 'text': row['text'], 'truncated': False, 'content_types': ['text']}
        return hit if self.fault == 'untagged' else {**hit, **self.tag(reader, row)}

    def search(self, reader, arguments):
        words = arguments['query'].split()
        rows = [row for row in self.messages if self.readable(reader, row) and all(word in row['text'] for word in words)]
        return {'sources': [self.hit(reader, row) for row in rows[:arguments.get('limit', 5)]], 'filter_status': None}

    def related(self, reader, row):
        return {'source': 'nocheh:event:'+row['id'], **{key: value for key, value in self.tag(reader, row).items() if key != 'at'}, 'text': row['text']}

    def read(self, reader, arguments):
        row = self.message_of(arguments['id'].removeprefix('nocheh:event:'))
        if not self.readable(reader, row):
            return {'error': 'archive_source_unavailable'}
        result = {'source': 'nocheh:event:'+row['id'], 'scope': str(row['chat']), 'origin': 'live', 'kind': 'telegram_update', 'text': row['text'],
                  'truncated': False, 'reaction_observation': None, 'current_reactions': {'sources': [], 'complete': True}, 'artifacts': [], 'derived': []}
        if self.fault == 'untagged':
            return result
        result.update(self.tag(reader, row), chat_id=str(row['chat']))
        if row['topic'] is not None:
            result['topic'] = self.place((None, None), row['chat'], row['topic']) if not self.owner_reader(reader) else self.place(reader, row['chat'], row['topic'])
        target = self.message_of(row['reply_to'] or row['outside_to'])
        if self.readable(reader, target):
            result['reply_to'] = self.related(reader, target)
            chain, further = [], self.message_of(target['reply_to'])
            while further is not None and self.readable(reader, further) and len(chain) < arguments.get('chain', 1):
                chain.append(self.related(reader, further))
                further = self.message_of(further['reply_to'])
            if chain:
                result['chain'] = chain
        replies = [item for item in self.messages if row['id'] in (item['reply_to'], item['outside_to'])
                   and (self.readable(reader, item) or self.fault == 'outside_reply_in_group' and item['id'] not in self.retired)]
        result['replies'] = {'count': len(replies), 'items': [self.related(reader, item) for item in replies[:arguments.get('replies', 3)]]}
        return result

    # Stored chat history, notes and recall ------------------------------------------------------------------------------

    def planned(self, session):
        """The turns whose rows quote a retired message (retired_history.plan): the quote goes, and with it the turn's tool
        rows and the notes it wrote."""
        if self.fault == 'history_kept':
            return set()
        return {row['turn'] for row in self.history.get(session, []) if row['role'] == 'user' and set(row['cites']) & self.retired}

    def bring_current(self, session):
        """What Nocheh's turn does first (retired_history.withhold_retired)."""
        turns = set() if self.fault == 'turn_kept' else self.planned(session)
        for row in self.history.get(session, []):
            if row['turn'] in turns and row['role'] in ('user', 'tool'):
                row['text'], row['cites'] = row['own'] if row['role'] == 'user' else '[withheld]', []
        if self.fault != 'note_kept':
            self.notes = [note for note in self.notes if note['turn'] not in turns]

    def recall(self, reader, query):
        if not self.owner_reader(reader):
            learned = [row for row in self.messages if 'LEARNMARK' in row['text'] and row['chat'] == reader[0]
                       and (self.fault != 'evidence_dropped' or row['topic'] == reader[1])]
            return {'sources': [{'source': 'nocheh:memory:w', 'kind': 'memory_inference', 'text': 'A boat leaves at nine.',
                                 'evidence_sources': ['nocheh:event:'+row['id'] for row in learned], 'limitations': []}]}
        hits = [{'kind': 'native_note', 'text': note['text'], 'place': self.place(reader, *note['session'])} for note in self.notes if query in note['text']]
        for session, rows in self.history.items():
            # A read-only search skips the rows a profile not yet brought current would withhold (withheld_ids).
            skipped = self.planned(session)
            for index, row in enumerate(rows):
                found = row['text'].find(query)
                if found < 0 or row['turn'] in skipped and row['role'] in ('user', 'tool'):
                    continue
                hit = {'kind': 'native_session', 'place': self.place(reader, *session), 'role': row['role'],
                       'text': '' if self.fault == 'session_text_empty' else row['text'][max(0, found-40):max(0, found-40)+120], 'at': '2026-11-17T10:00:00+00:00'}
                if self.fault == 'session_context':
                    hit['context'] = [item['text'] for item in rows[max(0, index-1):index+2] if item is not row]
                hits.append(hit)
        return {'sources': [], 'native': {'hits': hits}}

    def call(self, name, arguments, reader, turn):
        if name == 'mcp__nocheh__archive_search':
            return self.search(reader, arguments)
        if name == 'mcp__nocheh__archive_read':
            return self.read(reader, arguments)
        if name == 'mcp__nocheh__memory_recall':
            return self.recall(reader, arguments['query'])
        if name == 'memory':
            self.notes += [{'text': item['content'], 'turn': turn, 'session': reader} for item in arguments['operations']]
            return {'success': True}
        raise AssertionError('unexpected tool '+name)

    def turn(self, update, chat, topic=None, expect_reply=True, **_):
        row = self.archive(update)
        session = (row['chat'], row['topic'])
        if not row['addressed']:
            self.quiet.setdefault(session, []).append(row)
            return row['id'], None
        self.bring_current(session)
        rows = self.history.setdefault(session, [])
        earlier = '\n'.join(item['text'] for item in rows)
        recent = self.quiet.pop(session, [])
        block = ''.join('[Group message from '+item['name']+'] (source nocheh:event:'+item['id']+') '+item['text']+'\n' for item in recent)
        rows.append({'role': 'user', 'turn': row['id'], 'text': block+row['text'], 'own': row['text'], 'cites': [item['id'] for item in recent]})
        answers = []
        for name, argument in BRAIN.TOOL.findall(row['text']):
            result = json.dumps(self.call(name, json.loads(argument), session, row['id']), ensure_ascii=False)
            self.events.append({'directive': 'tool', 'tool': name, 'phase': 'final', 'argument': argument, 'result': result})
            rows.append({'role': 'tool', 'turn': row['id'], 'text': result, 'cites': re.findall('[a-f0-9]{64}', result)})
            answers.append(name+': '+result)
        found = BRAIN.DIRECTIVE.search(row['text'])
        if found and found[1] == 'recall':
            result = json.dumps(self.call('mcp__nocheh__memory_recall', {'query': found[2]}, session, row['id']), ensure_ascii=False)
            self.events.append({'directive': 'recall', 'tool': 'mcp__nocheh__memory_recall', 'phase': 'final', 'argument': found[2], 'result': result})
            rows.append({'role': 'tool', 'turn': row['id'], 'text': result, 'cites': re.findall('[a-f0-9]{64}', result)})
        elif found and found[1] == 'context':
            answers.append('context '+found[2]+(' present' if found[2] in earlier else ' absent'))
        elif found and found[1] == 'turn':
            answers.append('turn '+found[2]+' absent')
        answer = '[NO_REPLY]' if '[[after:silent]]' in row['text'] else '[brain] '+' '.join(answers)
        rows.append({'role': 'assistant', 'turn': row['id'], 'text': answer, 'cites': []})
        return row['id'], answer

    def silent_turn(self, update, chat, topic=None):
        event_id, _ = self.turn(update, chat, topic)
        return event_id, 0


class SourceTagScenarioTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    def run_scenario(self, name, fault=None):
        installation = Installation(Path(self.folder.name), fault)
        scenarios = ProductScenarios(installation, Path(self.folder.name))
        scenarios.current = {'scenario': name, 'gates': []}
        scenarios.turn, scenarios.silent_turn = installation.turn, installation.silent_turn
        scenarios.topic_chat = lambda chat, topic: str(chat)+'/'+str(topic)
        scenarios.honcho_learned = lambda mark: None
        with contextlib.redirect_stdout(io.StringIO()):
            getattr(scenarios, name)()
        return scenarios, installation

    def fails(self, name, fault, gate):
        with self.assertRaises(Failed) as failed:
            self.run_scenario(name, fault)
        self.assertEqual(str(failed.exception), gate)

    def test_search_hits_name_their_source(self):
        scenarios, installation = self.run_scenario('search_hits_name_their_source')
        observed = scenarios.current['observed']
        self.assertTrue(observed['owner']['bob'].endswith(' Europe/Berlin') and observed['group']['bob'].endswith(' UTC'))
        self.assertEqual(installation.zone, 'UTC', 'the owner\'s time zone is put back')
        self.fails('search_hits_name_their_source', 'untagged', 'owner_reads_bob_with_group_and_tasks_zone')
        self.fails('search_hits_name_their_source', 'owner_zone_everywhere', 'group_reads_bob_in_utc')
        self.fails('search_hits_name_their_source', 'owner_word_in_groups', 'group_reads_owner_by_telegram_name')

    def test_group_tags_stay_in_the_group(self):
        _, installation = self.run_scenario('group_tags_stay_in_the_group')
        self.assertNotIn((GROUP, 44), installation.topics, 'the owner\'s topic name is taken away again')
        self.fails('group_tags_stay_in_the_group', 'owner_topic_name_leaks', 'group_never_reads_the_owner_typed_topic_name')
        self.fails('group_tags_stay_in_the_group', 'untagged', 'owner_reads_the_name_the_owner_typed')

    def test_reply_thread_opens(self):
        self.run_scenario('reply_thread_opens')
        self.fails('reply_thread_opens', 'untagged', 'owner_reads_what_it_replies_to')
        self.fails('reply_thread_opens', 'outside_reply_in_group', 'group_reads_only_its_own_replies')

    def test_topic_sharing_group_keeps_evidence(self):
        self.run_scenario('topic_sharing_group_keeps_evidence')
        self.fails('topic_sharing_group_keeps_evidence', 'evidence_dropped', 'sibling_topic_evidence_kept')

    def test_retired_source_leaves_tags(self):
        scenarios, _ = self.run_scenario('retired_source_leaves_tags')
        gates = [gate['gate'] for gate in scenarios.current['gates']]
        self.assertEqual(gates[-3:], ['history_no_longer_holds_it', 'next_turn_no_longer_reads_it', 'note_removed'])
        self.fails('retired_source_leaves_tags', 'history_kept', 'history_no_longer_holds_it')
        self.fails('retired_source_leaves_tags', 'turn_kept', 'next_turn_no_longer_reads_it')
        self.fails('retired_source_leaves_tags', 'note_kept', 'note_removed')

    def test_owner_recall_session_hits_have_text(self):
        self.run_scenario('owner_recall_session_hits_have_text')
        self.fails('owner_recall_session_hits_have_text', 'session_text_empty', 'session_hits_have_their_text')
        self.fails('owner_recall_session_hits_have_text', 'session_context', 'no_neighbour_text')

    def test_every_scenario_is_in_the_full_tester(self):
        from tools.acceptance.full_test import TITLES
        from tools.acceptance.product_scenarios import PRODUCT_ORDER
        for name in ('search_hits_name_their_source', 'group_tags_stay_in_the_group', 'reply_thread_opens', 'topic_sharing_group_keeps_evidence',
                     'retired_source_leaves_tags', 'owner_recall_session_hits_have_text'):
            self.assertIn(name, PRODUCT_ORDER)
            self.assertIn(name, TITLES)
        self.assertLess(PRODUCT_ORDER.index('owner_recall_session_hits_have_text'), PRODUCT_ORDER.index('private_chat_stays_out_of_groups'))

    def test_a_learn_mark_is_learned_like_a_private_mark(self):
        privacy = provider().PrivacyCanary({})
        for mark in ('LEARNMARK12', 'PRIVATEMARK12'):
            learned = privacy.learned(privacy.LEARN+'\n<message idx="3" peer="person_a" target="true">boat at nine '+mark+'</message>')
            self.assertEqual(json.loads(learned)['explicit'][0]['source_indices'], [3], mark)
            self.assertIn(mark, json.loads(learned)['explicit'][0]['content'])
        self.assertIsNone(privacy.learned(privacy.LEARN+'\n<message idx="0" peer="person_a" target="true">boat at nine</message>'))
        privacy.check(['boat at nine LEARNMARK12 PROBEMARK4'])
        self.assertEqual(privacy.counts['private_text_in_group'], 0, 'a learn mark is not private text')


if __name__ == '__main__':
    unittest.main()
