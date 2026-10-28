import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch
from tools.development import privacy_scan


class PrivacyScanTests(unittest.TestCase):
    def compiled(self, text):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'terms.txt'; path.write_text(text)
            return privacy_scan.patterns(path)

    def test_plain_words_match_whole_words_ignoring_case(self):
        compiled = self.compiled('# comment\nJuniper\nexample.org\n')
        self.assertEqual(len(privacy_scan.findings('ask JUNIPER today', 'a', compiled)), 1)
        self.assertEqual(privacy_scan.findings('junipers and juniper-ish', 'a', compiled), [])
        self.assertEqual(len(privacy_scan.findings('see https://example.org/x', 'a', compiled)), 1)
        self.assertEqual(privacy_scan.findings('see https://myexample.org', 'a', compiled), [])

    def test_regex_terms_and_reports_never_repeat_the_word(self):
        compiled = self.compiled('regex:\\bthe Lab\\b\n')
        hits = privacy_scan.findings('one\nrun on the lab tonight', 'notes.md', compiled)
        self.assertEqual(hits, ['notes.md:2: private word on list line 1'])

    def test_refuses_to_run_without_a_word_list(self):
        with patch.dict('os.environ', {'NOCHEH_PRIVATE_TERMS_FILE': '/nonexistent/terms'}), \
             patch.object(privacy_scan, 'ROOT', Path('/nonexistent')), redirect_stderr(io.StringIO()):
            self.assertEqual(privacy_scan.main(['--tree']), 2)


if __name__ == '__main__':
    unittest.main()
