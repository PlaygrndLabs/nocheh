"""The full tester's source tag scenarios (tools/acceptance/product_scenarios.py, ADR-0261) pass on a product that names
each hit's source, opens a message with its thread and forgets a retired message at once, and that gives each recalled
fact its source line and opens it by its number (step 2), and fail on one that does what Nocheh did before, or that lets a
tag say more than its reader may know.

Each scenario runs here against a made-up installation: an archive of the messages the scenario sends, tags built the
way Nocheh's code words them, stored chat history with the recent block a group turn carries, native notes, recall, and
long-term memory learned by the tester's own fake deriver (installation-provider.py PrivacyCanary.learned), shown in a
turn's memory blocks and opened by record and number. A `fault` makes it behave like the old product or like a leak."""
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


PROVIDER = provider()
BRAIN, LEARNING = PROVIDER.ScriptedBrain, PROVIDER.PrivacyCanary({})
DAY, CLOCK = TIME.split(' ')
UNAVAILABLE = {'error': 'archive_source_unavailable'}
# The block titles and the opening line Nocheh's code writes (src/stores/native-memory.ts headers, src/fact-block.ts).
TITLES = {'speaker': '[what is known about the speaker]', 'owner': '[what is known about the owner; it may include conclusions drawn from things '
          'the owner forwarded or sent]', 'forwards_and_files': '[from forwards (other people\'s words) and files the owner sent (their contents, '
          'not the owner\'s typed words)]'}
OPEN = '[To open a fact\'s original: archive_read id={id} fact=<n>. Times are when the source message was sent.]'


class Installation(Fixture):
    """The fake Telegram, the archive and the brain's tools of a made-up installation, as the scenarios read them.

    Faults: `untagged` (hits and opened messages as before ADR-0261), `owner_zone_everywhere`, `owner_word_in_groups`,
    `owner_topic_name_leaks`, `outside_reply_in_group`, `evidence_dropped` (sibling topic evidence lost, V2),
    `session_text_empty` (V1), `session_context` (neighbour rows in hits), `history_kept` (B6.1 not applied), `turn_kept`
    (recall skips the quoting rows but the next turn still reads them), `note_kept`, `space_named`.
    Step 2 faults: `facts_unsourced` (a block of facts in prose, as before), `block_named_by_session`, `open_anywhere` (any
    group opens a record), `header_by_owner` (a fact citing the owner's message reads as the owner's), `forward_as_owner`,
    `evidence_sources_only` (recall lists messages, not facts), `uncapped` (a block past 20,000 characters),
    `retired_fact_opens` and `fact_rows_kept` (stored rows citing a record of a retired message stay)."""

    def __init__(self, directory, fault=None):
        self.directory, self.next_id, self.fault = directory, 1794900000, fault
        self.events, self.messages, self.retired, self.zone = [], [], set(), 'UTC'
        self.topics = {(GROUP, TEAM_TOPIC): ('Team plans', 'observed')}
        self.history, self.notes, self.quiet, self.records = {}, [], {}, {}

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
                                   and item['chat'] == outside['chat']['id']), None),
               'forward': ((message.get('forward_origin') or {}).get('chat') or {}).get('title')}
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
        forward = row.get('forward') and self.fault != 'forward_as_owner'
        if forward:
            who += ', forwarded from a channel shown as “'+row['forward']+'”'
        zone = self.zone if owner or self.fault == 'owner_zone_everywhere' else 'UTC'
        return {'tag': who+' · '+self.place(reader, row['chat'], row['topic'])+' · '+TIME+' '+zone,
                'by': 'forward' if forward else 'owner' if row['sender'] == OWNER else 'person', 'at': AT}

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
        if arguments['id'].startswith('nocheh:memory:'):
            return self.open_fact(reader, arguments)
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

    # Long-term memory: facts with their sources (ADR-0261 step 2) -------------------------------------------------------

    @staticmethod
    def learning_line(index, row, target):
        return ('<message idx="'+str(index)+'" peer="person_'+str(row['sender'])+'" target="'+('true' if target else 'false')
                + '" time="t">'+row['text']+'</message>')

    def facts(self):
        """What memory learned: each message's learning batch (the message, after the one before it in its chat when someone
        else wrote that) goes through the tester's own fake deriver, and each conclusion cites the messages it names, in its
        order. The owner's forwards are learned by the forwards-and-files participant. A retired message's facts are gone,
        as the rebuild after a retirement drops them."""
        found = []
        for index, row in enumerate(self.messages):
            before = next((item for item in reversed(self.messages[:index]) if (item['chat'], item['topic']) == (row['chat'], row['topic'])), None)
            batch = ([before] if before and before['sender'] != row['sender'] else [])+[row]
            learned = LEARNING.learned(LEARNING.LEARN+'\n'+'\n'.join(self.learning_line(position, item, item is row) for position, item in enumerate(batch)))
            for item in json.loads(learned)['explicit'] if learned else []:
                sources = [batch[position]['id'] for position in item['source_indices']]
                if not set(sources) & self.retired:
                    found.append({'peer': 'forwards' if row['forward'] else row['sender'], 'chat': row['chat'], 'topic': row['topic'],
                                  'content': item['content'], 'sources': sources})
        return found

    def fact_by(self, rows):
        """Whose words a fact rests on and the message its source line names (ADR-0261 B2.2): a person's, a forward's or a
        file's first, else the first."""
        tags = [(row, self.tag((OWNER, None), row)['by']) for row in rows]
        if self.fault == 'header_by_owner' and any(by == 'owner' for _, by in tags):
            return next((row, by) for row, by in tags if by == 'owner')
        return next(((row, by) for row, by in tags if by in ('person', 'forward', 'file')), tags[0])

    def record(self, reader, facts):
        """A record of facts a reader read, its id and every source of each fact."""
        identifier = hashlib.sha256(json.dumps([reader, [fact['sources'] for fact in facts], len(self.records)]).encode()).hexdigest()
        self.records[identifier] = {'reader': reader, 'facts': [{**fact, 'n': n} for n, fact in enumerate(facts, 1)]}
        return identifier

    def block(self, reader, about, facts):
        """A turn's block of facts as Nocheh's code writes it: grouped under source lines, each line with its time."""
        identifier = self.record(reader, facts)
        if self.fault == 'facts_unsourced':
            text = TITLES[about]+'\n'+'\n'.join(str(n)+'. ['+TIME+':00] '+fact['content'] for n, fact in enumerate(facts, 1))
            return {'source': 'nocheh:memory:'+str(reader[0]), 'kind': 'memory_inference', 'text': text, 'exact_citations': False,
                    'limitations': ['representation_has_no_exact_citations'], 'about': about}
        lines, last = [TITLES[about], OPEN.format(id='nocheh:memory:'+identifier)], None
        for n, fact in enumerate(facts, 1):
            row, by = self.fact_by([self.message_of(source) for source in fact['sources']])
            header = 'Source [by='+by+']: '+re.sub(r' \(@[^)]*\)', '', self.tag(reader, row)['tag']).replace(TIME+' '+(self.zone if self.owner_reader(reader) else 'UTC'), DAY)
            if header != last:
                lines.append(header)
                last = header
            lines.append('  '+str(n)+'. '+CLOCK+' '+fact['content'])
        text = ('[conversation summary]\n'+'x'*25000+'\n\n' if self.fault == 'uncapped' else '')+'\n'.join(lines)
        return {'source': 'nocheh:memory:'+(str(reader[0]) if self.fault == 'block_named_by_session' else identifier), 'kind': 'memory_inference',
                'text': text, 'exact_citations': True, 'limitations': [], 'about': about}

    def blocks(self, reader, sender):
        """The long-term memory blocks of a turn: a group's for its speaker within its chat, the owner's about the owner and
        about the owner's forwards and files."""
        facts = self.facts()
        if not self.owner_reader(reader):
            chosen = [fact for fact in facts if fact['peer'] == sender and (fact['chat'], fact['topic']) == reader][-100:]
            return [self.block(reader, 'speaker', chosen)] if chosen else []
        found = []
        for about, peer in (('owner', OWNER), ('forwards_and_files', 'forwards')):
            chosen = [fact for fact in facts if fact['peer'] == peer][-100:]
            found += [self.block(reader, about, chosen)] if chosen else []
        return found

    def open_fact(self, reader, arguments):
        """archive_read of a fact by its record and number: only its reader's group (the owner reads any), never once a source
        of it is retired; its text and its sources this reader may read, tagged."""
        record = self.records.get(arguments['id'].removeprefix('nocheh:memory:'))
        if record is None or not (self.owner_reader(reader) or record['reader'][0] == reader[0] or self.fault == 'open_anywhere'):
            return UNAVAILABLE
        fact = next((item for item in record['facts'] if item['n'] == arguments.get('fact')), None)
        if fact is None or set(fact['sources']) & self.retired and self.fault != 'retired_fact_opens':
            return UNAVAILABLE
        rows = [self.message_of(source) for source in fact['sources']]
        _, by = self.fact_by(rows)
        sources = [{'source': 'nocheh:event:'+row['id'], **{key: value for key, value in self.tag(reader, row).items() if key != 'at'}}
                   for row in rows if self.readable(reader, row)]
        return {'source': arguments['id'], 'fact': fact['n'], 'text': fact['content'], 'exact': True, 'by': by, 'at': AT, 'sources': sources[:10], 'more': 0}

    def record_retired(self, identifier):
        record = self.records.get(identifier)
        return record is not None and any(set(fact['sources']) & self.retired for fact in record['facts'])

    # Stored chat history, notes and recall ------------------------------------------------------------------------------

    def planned(self, session):
        """The turns whose rows quote a retired message (retired_history.plan): the quote goes, and with it the turn's tool
        rows and the notes it wrote."""
        if self.fault == 'history_kept':
            return set()
        return {row['turn'] for row in self.history.get(session, []) if row['role'] == 'user' and set(row['cites']) & self.retired}

    def cites_retired(self, row):
        """A stored tool row that cites a retired message, or a record of facts resting on one (retired_records, B6.2)."""
        return (self.fault != 'fact_rows_kept' and row['role'] == 'tool'
                and any(cited in self.retired or self.record_retired(cited) for cited in row['cites']))

    def bring_current(self, session):
        """What Nocheh's turn does first (retired_history.withhold_retired)."""
        turns = set() if self.fault == 'turn_kept' else self.planned(session)
        for row in self.history.get(session, []):
            if row['turn'] in turns and row['role'] in ('user', 'tool') or self.cites_retired(row):
                row['text'], row['cites'] = row['own'] if row['role'] == 'user' else '[withheld]', []
        if self.fault != 'note_kept':
            self.notes = [note for note in self.notes if note['turn'] not in turns]

    def recall(self, reader, query, sender=OWNER):
        if not self.owner_reader(reader):
            learned = [fact for fact in self.facts() if fact['peer'] == sender and fact['chat'] == reader[0]
                       and (self.fault != 'evidence_dropped' or fact['topic'] == reader[1])]
            answer = {'source': 'nocheh:memory:'+('w' if self.fault == 'space_named' else hashlib.sha256(query.encode()).hexdigest()),
                      'kind': 'memory_inference', 'text': 'A boat leaves at nine.', 'limitations': []}
            if self.fault == 'evidence_sources_only':
                return {'sources': [{**answer, 'evidence_sources': ['nocheh:event:'+source for fact in learned for source in fact['sources']]}]}
            # As storage answers (ADR-0261 B3.6): the answer and its facts named by their records, every fact stored, the first 12
            # listed, each with its first two sources tagged.
            record = self.record(reader, learned)
            facts = [{'n': n, 'text': fact['content'][:240], 'exact': True, 'by': self.fact_by([self.message_of(source) for source in fact['sources']])[1],
                      'sources': [{'source': 'nocheh:event:'+row['id'], **{key: value for key, value in self.tag(reader, row).items() if key != 'at'}}
                                  for row in map(self.message_of, fact['sources'][:2])], 'more': max(0, len(fact['sources'])-2)}
                     for n, fact in enumerate(learned, 1)][:12]
            return {'sources': [{**answer, 'facts_source': 'nocheh:memory:'+record, 'facts': facts, 'evidence_count': len(learned)}]}
        hits = [{'kind': 'native_note', 'text': note['text'], 'place': self.place(reader, *note['session'])} for note in self.notes if query in note['text']]
        for session, rows in self.history.items():
            # A read-only search skips the rows a profile not yet brought current would withhold (withheld_ids).
            skipped = self.planned(session)
            for index, row in enumerate(rows):
                found = row['text'].find(query)
                if found < 0 or row['turn'] in skipped and row['role'] in ('user', 'tool') or self.cites_retired(row):
                    continue
                hit = {'kind': 'native_session', 'place': self.place(reader, *session), 'role': row['role'],
                       'text': '' if self.fault == 'session_text_empty' else row['text'][max(0, found-40):max(0, found-40)+120], 'at': '2026-11-17T10:00:00+00:00'}
                if self.fault == 'session_context':
                    hit['context'] = [item['text'] for item in rows[max(0, index-1):index+2] if item is not row]
                hits.append(hit)
        return {'sources': [], 'native': {'hits': hits}}

    def call(self, name, arguments, reader, turn, sender=OWNER):
        if name == 'mcp__nocheh__archive_search':
            return self.search(reader, arguments)
        if name == 'mcp__nocheh__archive_read':
            return self.read(reader, arguments)
        if name == 'mcp__nocheh__memory_recall':
            return self.recall(reader, arguments['query'], sender)
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
            result = json.dumps(self.call(name, json.loads(argument), session, row['id'], row['sender']), ensure_ascii=False)
            self.events.append({'directive': 'tool', 'tool': name, 'phase': 'final', 'argument': argument, 'result': result})
            rows.append({'role': 'tool', 'turn': row['id'], 'text': result, 'cites': re.findall('[a-f0-9]{64}', result)})
            answers.append(name+': '+result)
        found = BRAIN.DIRECTIVE.search(row['text'])
        if found and found[1] == 'recall':
            result = json.dumps(self.call('mcp__nocheh__memory_recall', {'query': found[2]}, session, row['id'], row['sender']), ensure_ascii=False)
            self.events.append({'directive': 'recall', 'tool': 'mcp__nocheh__memory_recall', 'phase': 'final', 'argument': found[2], 'result': result})
            rows.append({'role': 'tool', 'turn': row['id'], 'text': result, 'cites': re.findall('[a-f0-9]{64}', result)})
        elif found and found[1] == 'memory_blocks':
            blocks = [{key: block.get(key) for key in ('source', 'about', 'exact_citations', 'limitations', 'text')} for block in self.blocks(session, row['sender'])]
            self.events.append({'directive': 'memory_blocks', 'argument': found[2], 'phase': 'final', 'blocks': blocks})
            answers.append('memory_blocks '+found[2])
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
        self.fails('topic_sharing_group_keeps_evidence', 'space_named', 'recall_names_its_records')

    def test_retired_source_leaves_tags(self):
        scenarios, _ = self.run_scenario('retired_source_leaves_tags')
        gates = [gate['gate'] for gate in scenarios.current['gates']]
        self.assertEqual(gates[-6:], ['history_no_longer_holds_it', 'fact_rows_leave_history', 'fact_no_longer_opens', 'recalled_fact_no_longer_opens',
                                      'next_turn_no_longer_reads_it', 'note_removed'])
        self.assertTrue({'turn_read_the_fact', 'fact_opened_before', 'recall_listed_the_fact', 'history_holds_the_fact_rows_before'} <= set(gates))
        self.fails('retired_source_leaves_tags', 'history_kept', 'history_no_longer_holds_it')
        self.fails('retired_source_leaves_tags', 'turn_kept', 'next_turn_no_longer_reads_it')
        self.fails('retired_source_leaves_tags', 'note_kept', 'note_removed')
        self.fails('retired_source_leaves_tags', 'fact_rows_kept', 'fact_rows_leave_history')
        self.fails('retired_source_leaves_tags', 'retired_fact_opens', 'fact_no_longer_opens')
        self.fails('retired_source_leaves_tags', 'facts_unsourced', 'turn_read_the_fact')

    def test_owner_recall_session_hits_have_text(self):
        self.run_scenario('owner_recall_session_hits_have_text')
        self.fails('owner_recall_session_hits_have_text', 'session_text_empty', 'session_hits_have_their_text')
        self.fails('owner_recall_session_hits_have_text', 'session_context', 'no_neighbour_text')

    # Facts that name their source (ADR-0261 step 2) ----------------------------------------------------------------------

    def test_recalled_fact_opens_its_original(self):
        scenarios, _ = self.run_scenario('recalled_fact_opens_its_original')
        self.assertTrue(scenarios.current['observed']['fact']['header'].startswith('Source [by=person]: “Bob” · this chat · '))
        self.fails('recalled_fact_opens_its_original', 'facts_unsourced', 'fact_reaches_the_turn')
        self.fails('recalled_fact_opens_its_original', 'block_named_by_session', 'block_named_by_its_record')
        self.fails('recalled_fact_opens_its_original', 'open_anywhere', 'other_group_cannot_open_it')

    def test_fact_about_bob_names_bob(self):
        scenarios, _ = self.run_scenario('fact_about_bob_names_bob')
        self.assertIn('answered a question about LEARNMARK', scenarios.current['observed']['fact']['text'], 'the fake deriver learned the answer')
        self.fails('fact_about_bob_names_bob', 'header_by_owner', 'source_line_names_bob_not_the_owner')
        self.fails('fact_about_bob_names_bob', 'owner_word_in_groups', 'question_reads_by_the_owners_telegram_name')

    def test_recall_facts_carry_sources(self):
        scenarios, _ = self.run_scenario('recall_facts_carry_sources')
        self.assertEqual(scenarios.current['observed']['count'], 3)
        self.fails('recall_facts_carry_sources', 'evidence_sources_only', 'recall_names_its_answer_and_facts')
        self.fails('recall_facts_carry_sources', 'open_anywhere', 'other_group_cannot_open_it')

    def test_forward_fact_names_its_origin(self):
        scenarios, _ = self.run_scenario('forward_fact_names_its_origin')
        self.assertEqual(scenarios.current['observed']['about'], 'forwards_and_files')
        self.fails('forward_fact_names_its_origin', 'forward_as_owner', 'source_line_names_the_channel')
        self.fails('forward_fact_names_its_origin', 'facts_unsourced', 'fact_in_the_forwards_and_files_block')

    def test_per_turn_memory_stays_small(self):
        scenarios, _ = self.run_scenario('per_turn_memory_stays_small')
        self.assertEqual(set(scenarios.current['observed']['timings']), {'owner', 'group'})
        self.assertTrue(all(set(value) == {'first_seconds', 'p50_seconds', 'p95_seconds'} for value in scenarios.current['observed']['timings'].values()))
        self.fails('per_turn_memory_stays_small', 'uncapped', 'blocks_within_their_caps')
        self.fails('per_turn_memory_stays_small', 'facts_unsourced', 'each_turn_reads_facts')
        self.fails('per_turn_memory_stays_small', 'block_named_by_session', 'blocks_named_by_their_records')

    def test_a_fact_answering_another_peers_marked_question_cites_the_answer_then_the_question(self):
        privacy = provider().PrivacyCanary({})
        batch = (privacy.LEARN+'\n<message idx="4" peer="person_owner" target="false" time="t">Bob, is LEARNMARK12 still 4321?</message>\n'
                 '<message idx="5" peer="person_bob" target="true" time="t">yes</message>')
        self.assertEqual(json.loads(privacy.learned(batch))['explicit'], [{'source_indices': [5, 4], 'content': 'person_bob answered a question about LEARNMARK12'}])
        self.assertIsNone(privacy.learned(batch.replace('LEARNMARK12', 'nothing')), 'only a question with a learn mark')
        self.assertIsNone(privacy.learned(batch.replace('LEARNMARK12', 'PRIVATEMARK12')), 'a private mark is never learned about someone else')
        self.assertIsNone(privacy.learned(batch.replace('person_owner', 'person_bob')), 'only another peer\'s question')
        self.assertEqual([item['source_indices'] for item in json.loads(privacy.learned(batch.replace('>yes<', '>yes LEARNMARK13<')))['explicit']], [[5]],
                         'an answer with its own mark is learned as before')

    def test_every_scenario_is_in_the_full_tester(self):
        from tools.acceptance.full_test import TITLES
        from tools.acceptance.product_scenarios import PRODUCT_ORDER
        for name in ('search_hits_name_their_source', 'group_tags_stay_in_the_group', 'reply_thread_opens', 'topic_sharing_group_keeps_evidence',
                     'retired_source_leaves_tags', 'owner_recall_session_hits_have_text', 'recalled_fact_opens_its_original', 'fact_about_bob_names_bob',
                     'recall_facts_carry_sources', 'forward_fact_names_its_origin', 'per_turn_memory_stays_small'):
            self.assertIn(name, PRODUCT_ORDER)
            self.assertIn(name, TITLES)
        self.assertLess(PRODUCT_ORDER.index('owner_recall_session_hits_have_text'), PRODUCT_ORDER.index('private_chat_stays_out_of_groups'))
        # A recall lists 12 facts, cited ones first: GUEST's facts are listed while the retirement has not yet forgotten one.
        self.assertLess(PRODUCT_ORDER.index('recall_facts_carry_sources'), PRODUCT_ORDER.index('retired_source_leaves_tags'))
        self.assertGreater(PRODUCT_ORDER.index('forward_fact_names_its_origin'), PRODUCT_ORDER.index('forward_kept_apart_and_labelled'))

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
