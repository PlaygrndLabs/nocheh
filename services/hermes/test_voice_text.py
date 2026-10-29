"""Voice notes transcribed by Hermes's own transcriber for Nocheh's preparation step."""
import base64
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from services.hermes import usage, voice_text

ROUTE = {'NOCHEH_TRANSCRIPTION_ROUTE_URL': 'https://transcribe.example.test/v1', 'NOCHEH_TRANSCRIPTION_ROUTE_KEY': 'synthetic-voice-key',
         'NOCHEH_TRANSCRIPTION_ROUTE_MODEL': 'gpt-transcribe', 'NOCHEH_TRANSCRIPTION_ROUTE_PROVIDER': 'openai',
         'NOCHEH_TRANSCRIPTION_ROUTE_PRICE': '0.0045'}


def transcriber(result):
    module = types.ModuleType('tools.transcription_tools')
    module.calls = []

    def transcribe(path):
        module.calls.append((Path(path).name, Path(path).read_bytes()))
        return result
    module.transcribe_audio = transcribe
    return module


class VoiceTextTests(unittest.TestCase):
    def read(self, result, **hint):
        module = transcriber(result)
        with patch.dict(sys.modules, {'tools.transcription_tools': module}), patch.object(voice_text, 'duration', return_value=61.2):
            return voice_text.read(b'synthetic audio', {'name': '', 'mime_type': '', 'kind': '', **hint}), module.calls

    def test_the_format_comes_from_the_name_the_mime_type_or_the_kind(self):
        found, calls = self.read({'success': True, 'transcript': 'Synthetic note about the garden club'}, name='voice_messages/a.OGG')
        self.assertEqual(found, {'state': 'done', 'text': 'Synthetic note about the garden club', 'seconds': 61.2})
        self.assertEqual(calls, [('voice.ogg', b'synthetic audio')], 'the original name never reaches the transcriber')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, mime_type='audio/mpeg; codecs=mp3')[1][0][0], 'voice.mp3')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, kind='voice')[1][0][0], 'voice.ogg')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, kind='video_note')[1][0][0], 'voice.mp4')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, name='a.bin', kind='audio'), ({'state': 'unsupported'}, []))

    def test_failures_say_whether_a_retry_can_help(self):
        cases = {'Connection error: Request timed out.': 'timed_out', 'Connection error: refused': 'provider_error',
                 'API error: Error code: 429 - slow down': 'rate_limited', 'API error: Error code: 503 - busy': 'provider_error',
                 'API error: Error code: 401 - bad key': 'key_rejected', 'API error: Error code: 400 - corrupted': 'bad_answer',
                 'Transcription failed: odd': 'unknown'}
        for error, reason in cases.items():
            self.assertEqual(self.read({'success': False, 'transcript': '', 'error': error}, kind='voice')[0],
                             {'state': 'failed', 'reason': reason, 'seconds': 61.2}, error)
        self.assertEqual(self.read({'success': False, 'error': 'Unsupported format: .xyz'}, kind='voice')[0], {'state': 'unsupported'})
        self.assertEqual(self.read({'success': True, 'transcript': '  '}, kind='voice')[0], {'state': 'silent', 'seconds': 61.2})

    def test_without_a_key_voice_notes_are_archived_only(self):
        with patch.dict('os.environ', {**ROUTE, 'NOCHEH_TRANSCRIPTION_ROUTE_KEY': ''}), patch.object(voice_text.subprocess, 'run') as run:
            self.assertEqual(voice_text.transcribe({'check': True}), {'configured': False})
            self.assertEqual(voice_text.transcribe({'bytes_base64': ''}), {'state': 'not_configured'})
            run.assert_not_called()
        with patch.dict('os.environ', ROUTE):
            self.assertEqual(voice_text.transcribe({'check': True}), {'configured': True})

    def test_a_child_with_its_own_hermes_home_and_only_the_voice_key_transcribes_and_usage_is_priced(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'kind': 'voice', 'duration': 30}
        seen = {}

        def run(command, **options):
            home = Path(options['env']['HERMES_HOME'])
            seen.update(env=options['env'], config=json.loads((home / 'config.yaml').read_text()), timeout=options['timeout'],
                        hint=json.loads(command[-1]))
            return subprocess.CompletedProcess(command, 0, b'Hermes says hello\n{"state": "done", "text": "Synthetic", "seconds": 90.4}', b'')
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', {**ROUTE, 'SERVICE_TOKEN': 'synthetic-service-token'}), \
                patch.object(voice_text.subprocess, 'run', side_effect=run):
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic'})
                self.assertFalse(Path(seen['env']['HERMES_HOME']).exists(), 'the child home is removed')
                rows = usage.rows('2000-01-01', target)
        self.assertNotIn('SERVICE_TOKEN', seen['env'])
        self.assertEqual(seen['env'][voice_text.KEY], 'synthetic-voice-key')
        self.assertEqual(seen['config']['stt'], {'enabled': True, 'provider': 'openai', 'openai': {
            'model': 'gpt-transcribe', 'base_url': 'https://transcribe.example.test/v1', 'api_key': '${env:' + voice_text.KEY + '}'}},
            'the key is read from the environment, never written to the file')
        self.assertEqual(seen['timeout'], voice_text.SECONDS)
        self.assertEqual(seen['hint'], {'name': '', 'mime_type': '', 'kind': 'voice', 'duration': 30})
        self.assertEqual([(row['part'], row['model'], row['runs'], row['audio_seconds'], row['priced_runs']) for row in rows],
                         [('transcription', 'gpt-transcribe', 1, 90.4, 1)])
        self.assertAlmostEqual(rows[0]['cost_usd'], 91 / 60 * 0.0045)

    def test_a_hung_or_broken_child_is_a_failure_to_retry_and_oversized_audio_is_never_sent(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'kind': 'voice'}
        with patch.dict('os.environ', ROUTE):
            with patch.object(voice_text.subprocess, 'run', side_effect=subprocess.TimeoutExpired('voice', 1)):
                self.assertEqual(voice_text.transcribe(body), {'state': 'failed', 'reason': 'timed_out'})
            with patch.object(voice_text.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'Traceback', b'')):
                self.assertEqual(voice_text.transcribe(body), {'state': 'failed', 'reason': 'nocheh_error'})
            with patch.object(voice_text, 'LIMIT', 3), patch.object(voice_text.subprocess, 'run') as run:
                self.assertEqual(voice_text.transcribe(body), {'state': 'too_large'})
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
