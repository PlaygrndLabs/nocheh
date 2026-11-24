import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Dataset(unittest.TestCase):
    def test_validator_passes(self):
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "validate.py"), "--quiet"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
