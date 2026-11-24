"""The full tester's check that Honcho's provider gateway refuses every privacy probe (private_chat_stays_out_of_groups,
ADR-0241). The fixture model answers a group question's memory chat by calling get_recent_observations, a tool the chat
did not offer (installation-provider.py PrivacyCanary.probe); the gateway (services/honcho/meter.py) refuses that answer
and logs one line for it, which the scenario counts. Both ends are run here: the fixture's own answer, as JSON and as an
event stream, through the real gateway, and the scenario's count of that log since a starting point."""
import asyncio
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.acceptance.product_scenarios import GATEWAY_REFUSAL, ProductScenarios
from tools.paths import ROOT


def load(name, path, environment=None):
    spec = importlib.util.spec_from_file_location(name, ROOT/path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, environment or {}):
        spec.loader.exec_module(module)
    return module


PROVIDER = load('installation_provider', 'tools/acceptance/rehearsals/installation-provider.py', {'NOCHEH_INSTALLATION_FIXTURE': '1'})
METER = load('honcho_meter', 'services/honcho/meter.py')
# What Honcho's memory chat offers (H:src/utils/agent_tools.py DIALECTIC_TOOLS); get_recent_observations is not among them.
OFFERED = ('search_memory', 'search_messages', 'get_observation_context', 'grep_messages', 'get_messages_by_date_range',
           'search_messages_temporal', 'get_reasoning_chain')


class Provider:
    """The fixture model behind the gateway: one fixed answer."""
    def __init__(self, body, kind):
        self.body, self.kind = body, kind

    def open(self, request, timeout):
        response = io.BytesIO(self.body)
        response.status, response.headers = 200, {'Content-Type': self.kind}
        return response


class GatewayRefusesEveryProbeTests(unittest.TestCase):
    def probe_answer(self, stream):
        """The fixture's answer to a group question's memory chat, as it sends it, and the request it answers."""
        payload = {'model': METER.REASONING_MODEL, 'messages': [{'role': 'user', 'content': 'What does the owner do on Fridays? PROBEMARK7'}],
                   'tools': [{'type': 'function', 'function': {'name': name, 'parameters': {'type': 'object'}}} for name in OFFERED],
                   **({'stream': True} if stream else {})}
        body = SimpleNamespace(model=payload['model'], messages=[SimpleNamespace(**message) for message in payload['messages']],
                               tools=payload['tools'], stream=stream, stream_options=None, response_format=None)
        counts = {}
        probe = PROVIDER.PrivacyCanary(counts).probe(body, [message['content'] for message in payload['messages']])
        self.assertEqual((probe['tool'], counts['privacy_probes']), ('get_recent_observations', 1))
        responses = SimpleNamespace(JSONResponse=None, StreamingResponse=lambda content, media_type: SimpleNamespace(content=content, media_type=media_type))
        with patch.dict('sys.modules', {'fastapi': SimpleNamespace(responses=responses), 'fastapi.responses': responses}):
            rendered = PROVIDER.ScriptedAgent({}, 'fixture-canary').render(body, probe)
        if not stream:
            return payload, json.dumps(rendered).encode(), 'application/json'

        async def chunks():
            return b''.join([chunk async for chunk in rendered.content])
        return payload, asyncio.run(chunks()), rendered.media_type

    def test_the_gateway_refuses_the_fixture_probe_and_logs_the_line_the_scenario_counts(self):
        for stream in (False, True):
            with self.subTest(stream=stream), tempfile.TemporaryDirectory() as root:
                payload, answer, kind = self.probe_answer(stream)
                gateway = METER.Egress(METER.Ledger(Path(root)/'budget.sqlite'), 'internal', 'temporary', Provider(answer, kind),
                                       reasoning_key='k', reasoning_url='https://gateway.example.test/v1')
                log = io.StringIO()
                with patch('sys.stderr', log), self.assertRaises(METER.UnofferedTool):
                    gateway.send('/v1/chat/completions', payload)
                self.assertEqual(log.getvalue().count(GATEWAY_REFUSAL), 1, log.getvalue())


class Gateway:
    """The fixture's `docker compose logs honcho-provider-gateway`: each read shows the next log, the last one after that."""
    def __init__(self, *lines):
        self.logs, self.reads = [''.join(line+'\n' for line in shown) for shown in lines], 0

    def run(self, *command, **options):
        self.command = command
        self.reads += 1
        return SimpleNamespace(stdout=self.logs[min(self.reads, len(self.logs))-1])


class RefusalWindowTests(unittest.TestCase):
    REFUSED = 'honcho-provider-gateway-1  | {'+GATEWAY_REFUSAL+'}'
    OTHER = 'honcho-provider-gateway-1  | {"event": "honcho_unoffered_tool_refused", "tools": ["other"]}'

    def scenarios(self, gateway):
        return ProductScenarios(gateway, Path(tempfile.gettempdir()))

    def test_refusals_before_the_window_are_not_counted(self):
        gateway = Gateway([self.REFUSED, self.REFUSED], [self.REFUSED, self.REFUSED, self.OTHER, self.REFUSED, self.REFUSED, self.REFUSED])
        scenarios = self.scenarios(gateway)
        earlier = scenarios.gateway_refusals()
        self.assertEqual(gateway.command, ('logs', '--no-color', 'honcho-provider-gateway'))
        self.assertEqual(scenarios.refused_since(earlier, 3), 3, 'three probes, three refusals; another tool is not a probe\'s')

    def test_a_refusal_logged_a_moment_after_its_probe_is_waited_for(self):
        gateway = Gateway([], [self.REFUSED], [self.REFUSED, self.REFUSED])
        scenarios = self.scenarios(gateway)
        earlier = scenarios.gateway_refusals()
        with patch('tools.acceptance.product_scenarios.time.sleep') as sleep:
            self.assertEqual(scenarios.refused_since(earlier, 2), 2)
        self.assertEqual(sleep.call_count, 1)

    def test_a_probe_the_gateway_never_refused_leaves_the_count_short(self):
        gateway = Gateway([self.REFUSED], [self.REFUSED, self.REFUSED])
        scenarios = self.scenarios(gateway)
        earlier = scenarios.gateway_refusals()
        self.assertEqual(scenarios.refused_since(earlier, 3, seconds=0), 1, 'the gate then fails: 1 refusal for 3 probes')
        self.assertEqual(scenarios.refused_since(earlier, 0, seconds=0), 1)


if __name__ == '__main__':
    unittest.main()
