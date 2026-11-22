"""forward_kept_apart_and_labelled (tools/acceptance/product_scenarios.py) passes on a product that keeps someone else's
forward with the owner's forwards and files, whenever Honcho learns the owner's next question, and fails on one that lets
the forward reach what is known about the owner (ADR-0257).

The scenario runs here against a made-up installation: long-term memory as the tester's Honcho keeps it, its conclusions
drawn by the fixture's own learning (installation-provider.py PrivacyCanary) about each message's writer, and the turn's
answer given by the fixture's own scripted agent from the blocks recall labels. The owner's question is learned before
the turn reads memory, as it was in a full run where it reached Honcho first."""
import contextlib
import importlib.util
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from services.hermes.memory_evidence import PREFIX
from tools.acceptance.product_scenarios import ProductScenarios
from tools.acceptance.telegram_scenarios import OWNER, Failed, Fixture
from tools.paths import ROOT

FORWARDS, ASSISTANT, PERSON = 'nocheh_forwards_and_files', 'nocheh_assistant', 'person_owner'
NAMED = 'forwarded by the sender from a person who hides their account'


def provider():
    spec = importlib.util.spec_from_file_location('installation_provider', ROOT/'tools/acceptance/rehearsals/installation-provider.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
        spec.loader.exec_module(module)
    return module


class Installation:
    """What the scenario reads of a made-up installation. `learned_about_owner`: Honcho also learns the forward about the
    owner. `owner_block_reads_forwards`: the owner's turn shows the forwards participant's conclusions in the owner's block."""
    def __init__(self, module, learned_about_owner=False, owner_block_reads_forwards=False):
        self.privacy = module.PrivacyCanary({})
        self.agent = module.ScriptedAgent({'chat': 0, 'raw_canary_outside_detector': 0}, 'fixture-canary')
        self.learned_about_owner, self.owner_block_reads_forwards = learned_about_owner, owner_block_reads_forwards
        self.messages, self.conclusions, self.typed = [], [], []

    def write(self, peer, text, observed=True):
        """One Honcho message, and what the fixture's learning concludes from it about its writer."""
        self.messages.append((peer, text))
        learned = self.privacy.learned(self.privacy.LEARN+'\n<message idx="0" peer="'+peer+'" target="true">'+text+'</message>')
        if observed and learned:
            self.conclusions += [(peer, peer, item['content']) for item in json.loads(learned)['explicit']]

    def block(self, peer):
        return '\n'.join(text for observer, observed, text in self.conclusions if observer == observed == peer)

    def turn(self, update, chat, *args, **options):
        message = update['message']
        if 'forward_origin' in message:
            self.write(FORWARDS, message['text']+'\n'+NAMED)
            if self.learned_about_owner:
                self.conclusions += [(PERSON, PERSON, text.replace(FORWARDS, PERSON)) for _, _, text in list(self.conclusions)]
            self.write(ASSISTANT, '[agent] turn a person who hides their account present', observed=False)
            return 'forward', '[agent] turn a person who hides their account present'
        self.typed.append(message['text'])
        self.write(PERSON, message['text'])
        owner = self.block(PERSON)+('\n'+self.block(FORWARDS) if self.owner_block_reads_forwards else '')
        sources = [{'source': 'nocheh:memory:a', 'kind': 'memory_inference', 'text': '[what is known about the owner]\n'+owner, 'about': 'owner'},
                   {'source': 'nocheh:memory:b', 'kind': 'memory_inference', 'text': '[from forwards]\n'+self.block(FORWARDS), 'about': 'forwards_and_files'}]
        evidence = PREFIX+json.dumps({'entries': [{'source': 'nocheh.memory.recall', 'content': {'sources': sources}}]})
        body = SimpleNamespace(messages=[SimpleNamespace(role='user', content=evidence), SimpleNamespace(role='user', content=message['text'])],
                               tools=[{'type': 'function', 'function': {'name': 'mcp__nocheh__memory_recall'}}], stream=False, stream_options=None, model='fixture')
        answer = self.agent.respond(body)['content']
        self.write(ASSISTANT, answer, observed=False)
        return 'question', answer

    def honcho(self, sql):
        if 'FROM queue' in sql:
            return '0'
        mark = re.search(r"content LIKE '%(PRIVATEMARK[0-9]+)%'", sql)[1]
        if 'FROM documents' in sql:
            held = sorted({observer+'/'+observed for observer, observed, text in self.conclusions if mark in text})
            return ','.join(held) if 'string_agg' in sql else str(len(held))
        texts = [(peer, text) for peer, text in self.messages if mark in text and (NAMED not in sql or NAMED in text)]
        return ','.join(sorted({peer for peer, _ in texts})) if 'string_agg' in sql else str(len(texts))


class MadeFixture(Fixture):
    """The fake Telegram's ids and messages, and the one archive read the scenario makes: its reply."""
    def __init__(self, directory):
        self.directory, self.next_id = directory, 1794900000

    def ids(self):
        self.next_id += 1
        return self.next_id

    def query(self, database, sql):
        return 'reply'


class ForwardMemoryReadTests(unittest.TestCase):
    def setUp(self):
        self.module = provider()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    def run_scenario(self, installation):
        scenarios = ProductScenarios(MadeFixture(Path(self.folder.name)), Path(self.folder.name))
        scenarios.current = {'scenario': 'forward_kept_apart_and_labelled', 'gates': []}
        writes = {'forward': [{'audience': 'owner', 'session': 'conversation', 'writer': 'assistant', 'record': 'labelled_pointer'},
                              {'audience': 'owner', 'session': 'material', 'writer': 'forwards_and_files', 'record': 'labelled_material'}],
                  'reply': [{'audience': 'owner', 'session': 'material', 'writer': 'assistant', 'record': 'labelled_source'}]}
        scenarios.turn, scenarios.honcho = installation.turn, installation.honcho
        scenarios.memory_writes = lambda event_id: {'writes': writes[event_id], 'sessions': len(writes[event_id])}
        with contextlib.redirect_stdout(io.StringIO()):
            scenarios.forward_kept_apart_and_labelled()
        return scenarios

    def test_the_owners_question_never_puts_the_forwarded_mark_in_the_owners_own_memory(self):
        installation = Installation(self.module)
        scenarios = self.run_scenario(installation)
        mark = next(iter(json.loads((Path(self.folder.name)/'canaries.json').read_text())['marks']))
        self.assertTrue(installation.typed, 'the owner asked about the forward')
        self.assertFalse([text for text in installation.typed if mark in text], 'what the owner types is learned about the owner')
        self.assertEqual(installation.block(PERSON), '', 'nothing learned about the owner holds the mark')
        gates = [gate['gate'] for gate in scenarios.current['gates']]
        self.assertIn('learned_only_by_forwards_and_files', gates)
        self.assertEqual(scenarios.current['gates'][-1]['gate'], 'read_in_the_forwards_and_files_block')
        self.assertTrue(scenarios.current['gates'][-1]['answer'].endswith(' forwards_and_files'))

    def test_a_forward_learned_about_the_owner_fails(self):
        with self.assertRaises(Failed) as failed:
            self.run_scenario(Installation(self.module, learned_about_owner=True))
        self.assertEqual(str(failed.exception), 'learned_only_by_forwards_and_files')

    def test_an_owner_block_that_shows_the_forwards_fails(self):
        with self.assertRaises(Failed) as failed:
            self.run_scenario(Installation(self.module, owner_block_reads_forwards=True))
        self.assertEqual(str(failed.exception), 'read_in_the_forwards_and_files_block')


if __name__ == '__main__':
    unittest.main()
