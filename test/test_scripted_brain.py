"""The fixture brain turns explicit directives into tool calls, never judgement."""
import importlib.util
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from tools.paths import ROOT


def load():
    spec=importlib.util.spec_from_file_location('installation_provider',ROOT/'tools/acceptance/rehearsals/installation-provider.py')
    module=importlib.util.module_from_spec(spec)
    with patch.dict(os.environ,{'NOCHEH_INSTALLATION_FIXTURE':'1'}):spec.loader.exec_module(module)
    return module


def message(role,content):return SimpleNamespace(role=role,content=content)


def request(*messages,tools=('nocheh_archive_search','nocheh_memory_recall','nocheh_action_request')):
    return SimpleNamespace(messages=list(messages),tools=[{'type':'function','function':{'name':name}} for name in tools],
                           stream=False,stream_options=None,model='fixture')


class ScriptedBrainTests(unittest.TestCase):
    def setUp(self):
        self.counts={'chat':0,'raw_canary_outside_detector':0}
        self.brain=load().ScriptedBrain(self.counts,'fixture-canary')

    def test_requests_without_directive_or_nocheh_tools_use_the_ordinary_mock(self):
        self.assertIsNone(self.brain.respond(request(message('user','ordinary message'))))
        self.assertIsNone(self.brain.respond(request(message('user','[[search:x]]'),tools=('other_tool',))))
        self.assertEqual(self.counts['chat'],0)

    def test_tool_directive_calls_once_then_answers_from_the_actual_result(self):
        user=message('user','please [[search:PRIVFACT91]]')
        self.assertEqual(self.brain.respond(request(message('system','rules'),user)),
                         {'tool':'nocheh_archive_search','arguments':{'mode':'text','query':'PRIVFACT91','limit':5}})
        result=json.dumps({'sources':[{'text':'fact PRIVFACT91'}]})
        final=self.brain.respond(request(user,message('assistant',None),message('tool',result)))
        self.assertTrue(final['content'].startswith('[brain] nocheh_archive_search: ')
                        and 'fact PRIVFACT91' in final['content'])
        action=self.brain.respond(request(message('user','[[action:-10042/topic/7|exact text]]')))
        self.assertEqual(action['arguments'],{'destination':'-10042/topic/7','text':'exact text'})

    def test_context_only_reports_earlier_messages_and_silence_and_blank_answers_are_explicit(self):
        older=message('user','remember MARK-1')
        present=self.brain.respond(request(older,message('assistant','ok'),message('user','[[context:MARK-1]]')))
        absent=self.brain.respond(request(message('user','[[context:MARK-1]]')))
        self.assertEqual((present['content'],absent['content']),('[brain] context MARK-1 present','[brain] context MARK-1 absent'))
        self.assertEqual(self.brain.respond(request(message('user','[[silent]]'))),{'content':'[NO_REPLY]'})
        blank=request(message('user','[[empty-once:E]]'))
        self.assertEqual(self.brain.respond(blank),{'content':''})
        self.assertEqual(self.brain.respond(blank),{'content':'[brain] recovered E'})

    def test_raw_canary_in_scripted_turn_is_counted_and_rejected(self):
        result=self.brain.respond(request(message('system','fixture-canary'),message('user','[[search:x]]')))
        self.assertEqual(result,{'error':'unguarded_fixture_canary'})
        self.assertEqual(self.counts['raw_canary_outside_detector'],1)


if __name__=='__main__':unittest.main()
