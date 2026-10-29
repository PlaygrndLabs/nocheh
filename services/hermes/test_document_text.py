"""Documents read by Hermes's own reader for Nocheh's preparation step."""
import base64
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

from services.hermes import document_text


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


if __name__ == '__main__':
    unittest.main()
