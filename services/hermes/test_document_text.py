"""Documents read by Hermes's own reader for Nocheh's preparation step."""
import base64
import errno
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

    def test_the_file_is_read_by_nocheh_reader(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'name': 'a.docx', 'mime_type': 7}
        with patch.object(document_text.reader_client, 'read', return_value=({'state': 'done', 'text': 'Synthetic', 'size': 0}, b'')) as read:
            self.assertEqual(document_text.extract(body), {'state': 'done', 'text': 'Synthetic'})
        read.assert_called_once_with('document', b'synthetic', {'name': 'a.docx', 'mime_type': ''})
        for answer in ({'state': 'failed', 'reason': 'timed_out'}, {'state': 'surprise'}, {}):
            with patch.object(document_text.reader_client, 'read', return_value=(answer, b'')):
                self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
        with patch.object(document_text.reader_client, 'read', side_effect=document_text.reader_client.ReaderUnavailable('busy')), \
                self.assertRaises(document_text.reader_client.ReaderUnavailable):
            document_text.extract(body)
        with patch.object(document_text, 'LIMIT', 3), patch.object(document_text.reader_client, 'read') as read:
            self.assertEqual(document_text.extract(body), {'state': 'too_large'})
            read.assert_not_called()

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
        child = lambda answer: patch.object(document_text.reader_client, 'read', return_value=(answer, b''))
        with tempfile.TemporaryDirectory() as state:
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                with child({'state': 'unreadable', 'write_failure': 'temp_full'}):
                    self.assertEqual(document_text.extract(body), {'state': 'unreadable'}, 'the file gets today’s status')
                with child({'state': 'unreadable', 'write_failure': 'made-up'}):
                    self.assertEqual(document_text.extract(body), {'state': 'unreadable'})
                with child({'state': 'done', 'text': 'Synthetic'}):
                    document_text.extract(body)
            day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            self.assertEqual(provider_usage.reader_rows(state, day),
                             [{'day': day, 'reader': 'document', 'done': 1, 'temp_full': 1, 'read_only': 0}])


if __name__ == '__main__':
    unittest.main()
