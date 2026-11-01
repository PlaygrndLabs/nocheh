import json
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from . import archive_tools

ID = 'a' * 64


def view(text):
    return {'id': ID, 'kind': 'mcp', 'state': 'done', 'result': {'content': text}, 'error_code': None, 'fingerprint': 'f' * 64}


class ActionResultTests(unittest.TestCase):
    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        for change in (patch.dict(os.environ, {'HERMES_HOME': home.name}), patch.object(archive_tools, '_PROCESS_PREFERENCES', {'nocheh_tools.mcp': 'on'})):
            change.start()
            self.addCleanup(change.stop)

    def test_long_result_comes_in_parts_that_join_to_the_whole_view(self):
        # Synthetic Persian task text, so a part boundary can fall inside non-Latin text.
        value = view('وظیفه ۱۲ انجام نشده است. ' * 2800)
        full = json.dumps({key: value.get(key) for key in archive_tools.RESULT_KEYS}, ensure_ascii=False)
        self.assertGreater(len(full), 24000)
        with patch.object(archive_tools, 'request', return_value=value) as request:
            first = json.loads(archive_tools.controlled_status({'id': ID}))
            parts = [first] + [json.loads(archive_tools.controlled_status({'id': ID, 'part': n})) for n in range(2, first['parts'] + 1)]
        self.assertEqual(''.join(part['text'] for part in parts), full)
        self.assertEqual({part['hash'] for part in parts}, {parts[0]['hash']})
        self.assertTrue(all('\\u06' not in archive_tools.in_parts(value, n) for n in range(1, first['parts'] + 1)))
        self.assertEqual({call.args[0] for call in request.call_args_list}, {'/v1/tools/actions/' + ID})
        self.assertNotIn('fingerprint', ''.join(part['text'] for part in parts))
        with patch.object(archive_tools, 'request', return_value=value):
            self.assertEqual(json.loads(archive_tools.controlled_status({'id': ID, 'part': first['parts'] + 1})),
                             {'id': ID, 'error': 'no_such_part', 'parts': first['parts']})

    def test_short_result_comes_whole_and_bad_parts_send_nothing(self):
        value = view('Synthetic short page')
        with patch.object(archive_tools, 'request', return_value=value):
            self.assertEqual(json.loads(archive_tools.controlled_status({'id': ID}))['result'], {'content': 'Synthetic short page'})
        with patch.object(archive_tools, 'request') as request:
            for part in (0, '2', True, 1.5):
                self.assertEqual(json.loads(archive_tools.controlled_status({'id': ID, 'part': part})), {'error': 'invalid_part'})
            request.assert_not_called()

    def test_notion_answer_matches_the_first_part_and_keeps_its_id_on_a_slow_poll(self):
        value = view('Synthetic row. ' * 3000)
        answers = [{'id': ID, 'state': 'approved'}, value]
        with patch.object(archive_tools, 'request', side_effect=lambda *a, **k: answers.pop(0)), patch.object(archive_tools.time, 'sleep'):
            first = archive_tools.notion_tool({'operation': 'call', 'tool': 'notion-fetch', 'input': {'id': 'synthetic'}})
        self.assertEqual(first, archive_tools.in_parts(value))
        answers = [{'id': ID, 'state': 'approved'}, TimeoutError('slow secret check')]

        def slow(*args, **kwargs):
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                self.assertLessEqual(kwargs['timeout'], 60)
                raise answer
            return answer
        with patch.object(archive_tools, 'request', side_effect=slow), patch.object(archive_tools.time, 'sleep'):
            self.assertEqual(json.loads(archive_tools.notion_tool({'operation': 'call', 'tool': 'notion-fetch', 'input': {}}))['id'], ID)
        with patch.object(archive_tools, 'request', side_effect=HTTPError('/', 409, 'changed', {}, None)):
            self.assertEqual(json.loads(archive_tools.notion_tool({'operation': 'list'})), {'error': 'notion_is_off_or_changed'})

    def test_proposals_and_results_get_the_secret_check_timeout(self):
        seen = []

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size): return b'{}'
        with patch.object(archive_tools, '_PROCESS_CREDENTIAL', 'synthetic-credential'), \
                patch('urllib.request.urlopen', side_effect=lambda req, timeout: seen.append(timeout) or Response()):
            archive_tools.request('/v1/tools/propose', {'kind': 'mcp'})
            archive_tools.request('/v1/tools/actions/' + ID)
            archive_tools.request('/v1/tools/actions')
            archive_tools.request('/v1/tools/actions/' + ID, timeout=7)
        self.assertEqual(seen, [60, 60, 15, 7])


if __name__ == '__main__':
    unittest.main()
