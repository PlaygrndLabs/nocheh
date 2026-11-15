"""Documents read by Hermes's own reader for Nocheh's preparation step."""
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

from services.hermes import document_text, usage
from tools.operations.provider import usage as provider_usage


class ExtractionError(Exception):
    pass


def reader(text=None, error=None):
    module = types.ModuleType('tools.read_extract')
    module.ExtractionError = ExtractionError
    module.is_extractable_document = lambda name: name.endswith(('.docx', '.pdf', '.pptx'))
    module.calls = []

    def extract(data, name):
        module.calls.append(name)
        if error: raise error
        return text
    module.extract_document_bytes = extract
    return module


class DocumentTextTests(unittest.TestCase):
    def read(self, module, name='', mime=''):
        with patch.dict(sys.modules, {'tools.read_extract': module}):
            return document_text.read(b'synthetic bytes', {'name': name, 'mime_type': mime})

    def test_the_type_comes_from_the_name_then_the_mime_type(self):
        module = reader('Synthetic slide about the garden club\n')
        self.assertEqual(self.read(module, 'Board/plan.PPTX'), {'state': 'done', 'text': 'Synthetic slide about the garden club\n'})
        self.assertEqual(self.read(module, 'scan', 'application/pdf; charset=binary')['state'], 'done')
        self.assertEqual(module.calls, ['document.pptx', 'document.pdf'], 'the original name never reaches the reader')
        self.assertEqual(self.read(reader('x'), 'notes.bin'), {'state': 'unsupported'})

    def test_scanned_and_broken_documents_say_so(self):
        self.assertEqual(self.read(reader(error=ExtractionError('NeedsOcrError: pages 1-3')), 'a.pdf'), {'state': 'scanned'})
        self.assertEqual(self.read(reader(error=ExtractionError('MalformedError: bad zip')), 'a.docx'), {'state': 'unreadable'})
        self.assertEqual(self.read(reader('  \n'), 'a.docx'), {'state': 'unreadable'})

    def test_hermes_agent_notes_become_a_plain_note_and_long_text_is_cut(self):
        noted = '[EXTRACTION COVERAGE WARNING: 2 of 3 pages in this PDF yielded no text. render with pdftoppm ... ranges.]\n## Synthetic total\n'
        self.assertEqual(self.read(reader(noted), 'a.pdf')['text'], document_text.SCANNED + '## Synthetic total\n')
        long = self.read(reader('a' * (document_text.TEXT_LIMIT + 5)), 'a.docx')['text']
        self.assertTrue(long.startswith('a' * document_text.TEXT_LIMIT) and long.endswith('[The rest of this document is not included.]'))

    def test_the_reading_runs_bounded_in_a_child_without_service_credentials(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'name': 'a.docx'}
        with patch.dict('os.environ', {'SERVICE_TOKEN': 'synthetic-service-token'}), \
                patch.object(document_text.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'{"state": "done", "text": "Synthetic"}', b'')) as run:
            self.assertEqual(document_text.extract(body), {'state': 'done', 'text': 'Synthetic'})
        self.assertNotIn('SERVICE_TOKEN', run.call_args.kwargs['env'])
        self.assertEqual(run.call_args.kwargs['timeout'], document_text.SECONDS)
        for outcome in (subprocess.TimeoutExpired('reader', 1), subprocess.CompletedProcess([], 1, b'Traceback', b'')):
            with patch.object(document_text.subprocess, 'run', side_effect=[outcome] if isinstance(outcome, Exception) else None,
                              return_value=None if isinstance(outcome, Exception) else outcome):
                self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
        with patch.object(document_text, 'LIMIT', 3), patch.object(document_text.subprocess, 'run') as run:
            self.assertEqual(document_text.extract(body), {'state': 'too_large'})
            run.assert_not_called()

    def test_each_read_has_its_own_temporary_folder_removed_after_it_even_after_a_timeout(self):
        # /tmp is memory in the locked-down container: a hung reader's files must not stay there.
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'name': 'a.pdf'}
        seen = {}

        def run(command, **options):
            seen.update(options['env'])
            Path(options['env']['TMPDIR'], 'left-by-the-converter').write_bytes(b'x' * 1024)
            raise subprocess.TimeoutExpired('reader', 1)
        with patch.dict('os.environ', {'HERMES_LAZY_INSTALL_TARGET': '/tmp/synthetic-target'}), \
                patch.object(document_text.subprocess, 'run', side_effect=run):
            self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
        self.assertEqual(seen['HOME'], seen['TMPDIR'])
        self.assertTrue(seen['TMPDIR'].startswith(tempfile.gettempdir()) and Path(seen['TMPDIR']).name.startswith('nocheh-document-'))
        self.assertFalse(Path(seen['TMPDIR']).exists(), 'nothing of the read is left in /tmp')
        # A feature missing from the image fails clearly instead of installing itself into the reader's folder.
        self.assertEqual(seen['HERMES_DISABLE_LAZY_INSTALLS'], '1')
        self.assertNotIn('HERMES_LAZY_INSTALL_TARGET', seen)

    def test_a_write_that_found_no_room_or_was_refused_is_counted_once_and_a_broken_file_is_not(self):
        full = OSError(errno.ENOSPC, 'No space left on device')
        refused = OSError(errno.EROFS, 'Read-only file system')
        chained = ExtractionError('OSError: no room')
        chained.__cause__ = full
        hint = {'name': 'a.docx', 'mime_type': ''}
        with patch.dict(sys.modules, {'tools.read_extract': reader(error=chained)}):
            self.assertEqual(document_text.answer(b'x', hint), {'state': 'unreadable', 'write_failure': 'temp_full'})
        with patch.dict(sys.modules, {'tools.read_extract': reader(error=refused)}):
            self.assertEqual(document_text.answer(b'x', hint), {'state': 'unreadable', 'write_failure': 'read_only'})
        # Only the error's number counts: a file can choose an error's words.
        with patch.dict(sys.modules, {'tools.read_extract': reader(error=ExtractionError('[Errno 28] No space left on device'))}):
            self.assertEqual(document_text.answer(b'x', hint), {'state': 'unreadable'})
        with patch.dict(sys.modules, {'tools.read_extract': reader(error=ValueError('synthetic bug'))}), \
                self.assertRaises(ValueError):
            document_text.answer(b'x', hint)

        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'name': 'a.docx'}
        child = lambda answer: subprocess.CompletedProcess([], 0, json.dumps(answer).encode(), b'')
        with tempfile.TemporaryDirectory() as state:
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                with patch.object(document_text.subprocess, 'run', return_value=child({'state': 'unreadable', 'write_failure': 'temp_full'})):
                    self.assertEqual(document_text.extract(body), {'state': 'unreadable'}, 'the file gets today’s status')
                with patch.object(document_text.subprocess, 'run', return_value=child({'state': 'unreadable'})), \
                        patch.object(usage, 'temp_full', return_value=False):
                    self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
                # A reader that failed while /tmp has no room for its file failed for want of room, whatever it said.
                with patch.object(document_text.subprocess, 'run', return_value=child({'state': 'unreadable'})), \
                        patch.object(usage, 'temp_full', return_value=True):
                    document_text.extract(body)
                # Its folder could not even be made.
                with patch.object(document_text.tempfile, 'TemporaryDirectory', side_effect=full), \
                        patch.object(document_text.subprocess, 'run') as run:
                    self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
                    run.assert_not_called()
                with patch.object(document_text.subprocess, 'run', return_value=child({'state': 'done', 'text': 'Synthetic'})):
                    document_text.extract(body)
            day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            self.assertEqual(provider_usage.reader_rows(state, day),
                             [{'day': day, 'reader': 'document', 'done': 1, 'temp_full': 3, 'read_only': 0}])


if __name__ == '__main__':
    unittest.main()
