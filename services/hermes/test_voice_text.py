"""Voice notes transcribed by Hermes's own transcriber for Nocheh's preparation step."""
import base64
import json
import shutil
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
        self.assertEqual(seen['config']['stt'], {'enabled': True, 'provider': 'openai', 'language': '', 'openai': {
            'model': 'gpt-transcribe', 'base_url': 'https://transcribe.example.test/v1', 'api_key': '${env:' + voice_text.KEY + '}'}},
            'the key is read from the environment, never written to the file')
        self.assertEqual(seen['timeout'], voice_text.SECONDS)
        self.assertEqual(seen['hint'], {'name': '', 'mime_type': '', 'kind': 'voice', 'duration': 30})
        self.assertEqual([(row['part'], row['model'], row['runs'], row['audio_seconds'], row['priced_runs']) for row in rows],
                         [('transcription', 'gpt-transcribe', 1, 90.4, 1)])
        self.assertAlmostEqual(rows[0]['cost_usd'], 91 / 60 * 0.0045)

    def test_a_part_asked_for_is_cut_first_and_only_the_cut_reaches_the_transcriber(self):
        steps = []

        def cut(path, seconds, target):
            steps.append(('cut', Path(path).name, Path(path).read_bytes(), seconds))
            Path(target).write_bytes(b'first part')
            return True

        def read(result, length, **hint):
            module = transcriber(result)
            original = module.transcribe_audio
            module.transcribe_audio = lambda path: (steps.append(('transcribe', Path(path).name)), original(path))[1]
            steps.clear()
            with patch.dict(sys.modules, {'tools.transcription_tools': module}), patch.object(voice_text, 'cut', side_effect=cut), \
                    patch.object(voice_text, 'duration', return_value=length):
                found = voice_text.read(b'synthetic audio', {'name': '', 'mime_type': '', 'kind': 'voice', **hint})
            return found, module.calls

        # Telegram says five seconds; the sender sets that, so the part asked for is cut anyway.
        found, calls = read({'success': True, 'transcript': 'Synthetic note'}, 900.0065, duration=5, first_seconds=900)
        self.assertEqual(found, {'state': 'done', 'text': 'Synthetic note', 'seconds': 900.0065, 'cut': True})
        self.assertEqual(steps, [('cut', 'voice.ogg', b'synthetic audio', 900), ('transcribe', 'first.ogg')], 'the cut comes first')
        self.assertEqual(calls, [('first.ogg', b'first part')], 'the transcriber hears only the cut')
        found, _ = read({'success': True, 'transcript': 'Synthetic note'}, 312.4, first_seconds=900)
        self.assertEqual(found, {'state': 'done', 'text': 'Synthetic note', 'seconds': 312.4}, 'a shorter recording is whole')
        found, _ = read({'success': True, 'transcript': ' '}, 900.0, first_seconds=900)
        self.assertEqual(found, {'state': 'silent', 'seconds': 900.0, 'cut': True})
        found, _ = read({'success': True, 'transcript': 'Synthetic note'}, None, first_seconds=900)
        self.assertEqual(found, {'state': 'done', 'text': 'Synthetic note', 'seconds': 900, 'cut': True},
                         'an unmeasured cut counts as the whole part, and as cut')
        found, _ = read({'success': False, 'error': 'API error: Error code: 503 - busy'}, 900.0, first_seconds=900)
        self.assertEqual(found, {'state': 'failed', 'reason': 'provider_error', 'cause': 'overloaded:503', 'seconds': 900.0})
        found, _ = read({'success': True, 'transcript': 'Synthetic note'}, 61.2)
        self.assertEqual((found, steps), ({'state': 'done', 'text': 'Synthetic note', 'seconds': 61.2}, [('transcribe', 'voice.ogg')]),
                         'without a part asked for, nothing is cut')
        module = transcriber({'success': True, 'transcript': 'never'})
        with patch.dict(sys.modules, {'tools.transcription_tools': module}), patch.object(voice_text, 'cut', return_value=False):
            self.assertEqual(voice_text.read(b'synthetic audio', {'name': '', 'mime_type': '', 'kind': 'voice', 'first_seconds': 900}),
                             {'state': 'failed', 'reason': 'nocheh_error', 'cause': 'audio_cut', 'seconds': 0})
        self.assertEqual(module.calls, [], 'a recording that cannot be cut is never sent whole')

    def test_the_part_reaches_the_child_and_usage_never_counts_the_senders_length(self):
        seen = []

        def child(answer):
            def run(command, **options):
                seen.append(json.loads(command[-1]))
                return subprocess.CompletedProcess(command, 0, answer, b'')
            return run
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'kind': 'voice', 'duration': 5, 'first_seconds': 900}
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', ROUTE):
            target = Path(state) / 'usage.sqlite'
            with patch.object(usage, 'DATABASE', target):
                with patch.object(voice_text.subprocess, 'run', side_effect=child(b'{"state": "done", "text": "Synthetic", "seconds": 900.0, "cut": true}')):
                    self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic', 'cut': True})
                self.assertEqual(seen[-1], {'name': '', 'mime_type': '', 'kind': 'voice', 'duration': 5, 'first_seconds': 900})
                with patch.object(voice_text.subprocess, 'run', side_effect=child(b'{"state": "done", "text": "Synthetic", "seconds": 12.0, "cut": false}')):
                    self.assertEqual(voice_text.transcribe(body), {'state': 'done', 'text': 'Synthetic'})
                with patch.object(voice_text.subprocess, 'run', side_effect=child(b'Traceback')):
                    self.assertEqual(voice_text.transcribe(body), {'state': 'failed', 'reason': 'nocheh_error'})
                rows = usage.rows('2000-01-01', target)
            self.assertEqual([(row['runs'], row['failed'], row['audio_seconds']) for row in rows], [(3, 1, 900.0 + 12.0 + 900)],
                             'a broken child counts the part asked for, never the five seconds the sender stated')
            refused = []
            for value in (0, 86401, 1.5, True, '900'):
                with patch.object(usage, 'DATABASE', Path(state) / 'refused.sqlite'), patch.object(voice_text.subprocess, 'run') as run:
                    refused.append(voice_text.transcribe({**body, 'first_seconds': value}))
                    run.assert_not_called()
            self.assertEqual(refused, [{'state': 'failed', 'reason': 'nocheh_error'}] * 5, 'a part asked for wrongly is never read whole')
            failed = usage.rows('2000-01-01', Path(state) / 'refused.sqlite')
            self.assertEqual(failed[0]['failed'], 5, 'each refusal is counted, so the owner is told')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg is not installed here')
    def test_ffmpeg_cuts_by_decoded_samples_and_keeps_only_the_sound(self):
        def make(*arguments):
            subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', *arguments], check=True, timeout=120)

        def heard(path):
            # Seconds of sound the provider would hear: the decoded samples counted one by one, at 1 kHz, whatever the
            # file's timestamps say.
            samples = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', path,
                                      '-ac', '1', '-ar', '1000', '-f', 'u8', '-'], capture_output=True, check=True, timeout=120)
            return len(samples.stdout) / 1000
        with tempfile.TemporaryDirectory() as work:
            long, stated, round_video, junk = (str(Path(work, name)) for name in ('long.wav', 'stated.mka', 'round.mp4', 'junk.ogg'))
            # Twenty minutes of a quiet tone at a low rate, so the file stays small.
            make('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=4000:duration=1200', '-ac', '1', '-c:a', 'pcm_u8', long)
            # The same twenty minutes, copied with its timestamps scaled down, so the file states about two minutes.
            make('-itsscale', '0.1', '-i', long, '-c', 'copy', stated)
            self.assertLess(voice_text.duration(stated), 130, 'the copy states a short length')
            self.assertGreater(heard(stated), 1199, 'and still holds all twenty minutes of sound')
            for source in (long, stated):
                target = str(Path(work, Path(source).stem + '.ogg'))
                self.assertTrue(voice_text.cut(source, 900, target), source)
                length = voice_text.duration(target)
                self.assertTrue(899.9 <= length <= 900.05, (source, length))
            # What the provider hears from the short-stated copy is fifteen minutes too, never the whole twenty.
            sound = heard(str(Path(work, 'stated.ogg')))
            self.assertTrue(899.9 <= sound <= 900.05, sound)
            # A round video: the picture is left out and only the sound is kept.
            make('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12',
                 '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', round_video)
            target = str(Path(work, 'round.ogg'))
            self.assertTrue(voice_text.cut(round_video, 5, target))
            streams = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', target],
                                     capture_output=True, text=True, check=True).stdout.split()
            self.assertEqual(streams, ['audio'])
            self.assertTrue(4.9 <= voice_text.duration(target) <= 5.05)
            Path(junk).write_bytes(b'OggS' + bytes(range(256)) * 8)
            self.assertFalse(voice_text.cut(junk, 900, str(Path(work, 'junk-cut.ogg'))))

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
