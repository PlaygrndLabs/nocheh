"""Voice notes transcribed by Hermes's own transcriber for Nocheh's preparation step."""
import base64
import errno
import json
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from services.hermes import usage, voice_text
from tools.operations.provider import usage as provider_usage

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


def made(state='done', seconds=None):
    """nocheh-reader's answer: the recording made again as Ogg Opus, with the length it measured."""
    def read(kind, data, hint):
        return ({'state': state, 'format': 'ogg', 'seconds': seconds}, b'OggS' + data) if state == 'done' else ({'state': state}, b'')
    return patch.object(voice_text.reader_client, 'read', side_effect=read)


class VoiceTextTests(unittest.TestCase):
    def setUp(self):
        reader = made()
        self.reader = reader.start()
        self.addCleanup(reader.stop)
    def read(self, result, **hint):
        module = transcriber(result)
        with patch.dict(sys.modules, {'tools.transcription_tools': module}):
            return voice_text.read(b'synthetic audio', {'name': '', 'mime_type': '', 'kind': '', 'duration': 61.2, **hint}), module.calls

    def test_the_format_comes_from_the_name_the_mime_type_or_the_kind(self):
        found, calls = self.read({'success': True, 'transcript': 'Synthetic note about the garden club'}, name='voice_messages/a.OGG')
        self.assertEqual(found, {'state': 'done', 'text': 'Synthetic note about the garden club', 'seconds': 61.2})
        self.assertEqual(calls, [('voice.ogg', b'synthetic audio')], 'the original name never reaches the transcriber')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, mime_type='audio/mpeg; codecs=mp3')[1][0][0], 'voice.mp3')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, kind='voice')[1][0][0], 'voice.ogg')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, kind='video_note')[1][0][0], 'voice.mp4')
        self.assertEqual(self.read({'success': True, 'transcript': 'x'}, name='a.bin', kind='audio'), ({'state': 'unsupported'}, []))

    def test_failures_say_whether_a_retry_can_help(self):
        cases = {'Connection error: Request timed out.': ('timed_out', 'timeout'), 'Connection error: refused': ('provider_error', 'connection'),
                 'API error: Error code: 429 - slow down': ('rate_limited', 'rate_limit:429'),
                 'API error: Error code: 503 - busy': ('provider_error', 'overloaded:503'),
                 'API error: Error code: 401 - bad key': ('key_rejected', 'auth:401'),
                 'API error: Error code: 400 - corrupted': ('bad_answer', 'format_error:400'),
                 'Transcription failed: odd': ('unknown', None)}
        for error, (reason, cause) in cases.items():
            self.assertEqual(self.read({'success': False, 'transcript': '', 'error': error}, kind='voice')[0],
                             {'state': 'failed', 'reason': reason, 'cause': cause, 'seconds': 61.2}, error)
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
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', {**ROUTE, 'AGENT_KEY': 'synthetic-agent-key-0123456789abcdef', 'NOCHEH_HERMES_SESSION_TOKEN': 'synthetic-session-token-0123456789ab'}), \
                patch.object(voice_text.subprocess, 'run', side_effect=run):
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic'})
                self.assertFalse(Path(seen['env']['HERMES_HOME']).exists(), 'the child home is removed')
                rows = usage.rows('2000-01-01', target)
        for name in ('SERVICE_TOKEN', 'AGENT_KEY', 'NOCHEH_HERMES_SESSION_TOKEN'): self.assertNotIn(name, seen['env'])
        self.assertEqual(seen['env'][voice_text.KEY], 'synthetic-voice-key')
        self.assertEqual(seen['config']['stt'], {'enabled': True, 'provider': 'openai', 'language': '', 'openai': {
            'model': 'gpt-transcribe', 'base_url': 'https://transcribe.example.test/v1', 'api_key': '${env:' + voice_text.KEY + '}'}},
            'the key is read from the environment, never written to the file')
        self.assertEqual(seen['timeout'], voice_text.SECONDS)
        self.assertEqual(seen['hint'], {'name': 'voice.ogg', 'mime_type': 'audio/ogg', 'kind': 'voice', 'duration': 30})
        self.assertEqual([(row['part'], row['model'], row['runs'], row['audio_seconds'], row['priced_runs']) for row in rows],
                         [('transcription', 'gpt-transcribe', 1, 90.4, 1)])
        self.assertAlmostEqual(rows[0]['cost_usd'], 91 / 60 * 0.0045)

    def test_every_recording_is_transcribed_whole_whoever_sent_it(self):
        # Nocheh no longer asks for a part (ADR-0264); a stray first_seconds never reaches the child or cuts anything.
        seen = []

        def run(command, **options):
            seen.append(json.loads(command[-1]))
            return subprocess.CompletedProcess(command, 0, b'{"state": "done", "text": "Synthetic", "seconds": 1200.0}', b'')
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'kind': 'voice', 'duration': 5, 'first_seconds': 900}
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', ROUTE):
            target = Path(state) / 'usage.sqlite'
            with patch.object(usage, 'DATABASE', target), patch.object(voice_text.subprocess, 'run', side_effect=run):
                self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic'})
                rows = usage.rows('2000-01-01', target)
        self.assertEqual(seen, [{'name': 'voice.ogg', 'mime_type': 'audio/ogg', 'kind': 'voice', 'duration': 5}])
        self.assertEqual([row['audio_seconds'] for row in rows], [1200.0], 'usage counts the whole recording')
        self.assertFalse(hasattr(voice_text, 'cut'))

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

    def test_a_refused_write_is_counted_for_the_notice_never_as_a_model_call(self):
        refused = OSError(errno.EROFS, 'Read-only file system')
        with patch.dict(sys.modules, {'tools.transcription_tools': transcriber({'success': True, 'transcript': 'x'})}), \
                patch.object(voice_text.Path, 'write_bytes', side_effect=refused):
            self.assertEqual(voice_text.answer(b'x', {'name': 'a.ogg', 'mime_type': '', 'kind': ''}),
                             {'state': 'failed', 'reason': 'nocheh_error', 'write_failure': 'read_only'})
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'kind': 'voice'}
        child = lambda answer: subprocess.CompletedProcess([], 0, json.dumps(answer).encode(), b'')
        seen = {}

        def run(command, **options):
            seen.update(options['env'])
            return child({'state': 'failed', 'reason': 'nocheh_error', 'write_failure': 'read_only'})
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', ROUTE):
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                with patch.object(voice_text.subprocess, 'run', side_effect=run):
                    self.assertEqual(voice_text.transcribe(body), {'state': 'failed', 'reason': 'nocheh_error'},
                                     'the recording gets today’s status')
                # A failure nobody explains, while /tmp has no room for the recording, failed for want of room.
                with patch.object(voice_text.subprocess, 'run', return_value=child({'state': 'failed', 'reason': 'unknown'})), \
                        patch.object(usage, 'temp_full', return_value=True):
                    voice_text.transcribe(body)
                with patch.object(voice_text.subprocess, 'run', return_value=child({'state': 'done', 'text': 'Synthetic', 'seconds': 2})):
                    voice_text.transcribe(body)
                calls = usage.rows('2000-01-01', target)
            day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            readers = provider_usage.reader_rows(state, day)
        self.assertEqual(readers, [{'day': day, 'reader': 'voice', 'done': 1, 'temp_full': 1, 'read_only': 1}])
        self.assertEqual([(row['part'], row['runs'], row['failed']) for row in calls], [('transcription', 1, 0)],
                         'only the transcription that reached the model is a model call')

    def test_only_what_the_reader_made_is_transcribed(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'name': 'a.m4a', 'kind': 'audio', 'duration': 30}
        seen = []

        def run(command, **options):
            seen.append((options['input'], json.loads(command[-1])))
            return subprocess.CompletedProcess(command, 0, b'{"state": "done", "text": "Synthetic", "seconds": 12.5}', b'')
        self.reader.side_effect = None
        self.reader.return_value = ({'state': 'done', 'format': 'ogg', 'seconds': 12.5}, b'OggS made')
        with patch.dict('os.environ', ROUTE), patch.object(voice_text.subprocess, 'run', side_effect=run), \
                patch.object(voice_text.usage, 'record'), patch.object(voice_text.usage, 'reader_done'):
            self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic'})
        self.reader.assert_called_once_with('audio', b'synthetic', {'name': 'a.m4a', 'mime_type': '', 'kind': 'audio'})
        # The reader's measured length wins over the one the sender stated.
        self.assertEqual(seen, [(b'OggS made', {'name': 'voice.ogg', 'mime_type': 'audio/ogg', 'kind': 'audio', 'duration': 12.5})])
        for answer, state in (({'state': 'unsupported'}, 'unsupported'), ({'state': 'too_large'}, 'too_large'),
                              ({'state': 'failed', 'reason': 'timed_out'}, 'too_large'), ({'state': 'unreadable'}, 'unsupported')):
            self.reader.return_value = (answer, b'')
            with patch.dict('os.environ', ROUTE), patch.object(voice_text.subprocess, 'run') as run:
                self.assertEqual(voice_text.transcribe(body), {'state': state}, answer)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
