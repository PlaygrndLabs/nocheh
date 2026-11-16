"""The tester's Honcho (tools/acceptance/rehearsals/installation-rehearsal.py) takes the real setup's limits and asks its
model for answers as the real setup does (tools/operations/memory/honcho_setup.py)."""
import importlib.util
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.memory import honcho_setup
from tools.paths import ROOT

# Settings that decide what Honcho takes and how it asks its model to answer; the rest name the fixture's own services.
SHARED = re.compile(r'(STRUCTURED_OUTPUT_MODE|MAX_OUTPUT_TOKENS|MAX_INPUT_TOKENS|MAX_QUERY_LENGTH)$')


def rehearsal():
    spec = importlib.util.spec_from_file_location('installation_rehearsal', ROOT/'tools/acceptance/rehearsals/installation-rehearsal.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TesterHonchoTests(unittest.TestCase):
    def test_tester_honcho_matches_the_real_setup_in_what_it_takes_and_how_it_asks_for_answers(self):
        from tools.operations.installation.configuration import initialize, read_env
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            initialize(state)
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=state/'honcho'):
                honcho_setup.initialize(state)
            real = {key: value for key, value in read_env(state/'honcho/honcho.env').items() if SHARED.search(key)}
        tester = rehearsal().honcho_env('synthetic-password', 'synthetic-token', 'synthetic-model')
        # Every dialectic level asks for json_object, which learning's response_format needs.
        for level in honcho_setup.DIALECTIC_LEVELS:
            self.assertEqual(real.get(f'DIALECTIC_LEVELS__{level}__MODEL_CONFIG__STRUCTURED_OUTPUT_MODE'), 'json_object')
        self.assertEqual({key: tester.get(key) for key in real}, real)


if __name__ == '__main__':
    unittest.main()
