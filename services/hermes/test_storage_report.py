import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation.configuration import initialize
from tools.operations.installation.storage import directory_size, measure, report


class StorageReportTests(unittest.TestCase):
    def test_report_measures_read_only_and_marks_stopped_services_and_external_links(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            state = Path(folder); initialize(state)
            (state / 'files').mkdir(exist_ok=True); (state / 'files/a.bin').write_bytes(b'x' * 1000)
            (Path(outside) / 'big.bin').write_bytes(b'x' * 5000)
            os.symlink(outside, state / 'files/linked')
            self.assertEqual(directory_size(state / 'files'), 1000, 'symlinked folders are not followed')
            calls = []

            def psql(command, **_):
                calls.append(command)
                if command[command.index('exec') + 2] == 'honcho-postgres':
                    raise subprocess.CalledProcessError(1, command)
                sql = command[-1]
                self.assertTrue(sql.startswith('SET default_transaction_read_only=on; '))
                return 'nocheh_control\t2048\n' if 'pg_database_size' in sql else 'workflow_registry\t1024\t7\n'

            with patch('tools.operations.installation.storage.subprocess.check_output', side_effect=psql):
                result = report(state, command=['docker', 'compose'], env={})
            measured = {row['database']: row for row in result['databases']}
            self.assertEqual(measured['nocheh_control']['largest_tables'], [{'table': 'workflow_registry', 'bytes': 1024, 'estimated_rows': 7}])
            self.assertEqual(measured['nocheh_archive']['role'], 'owned originals')
            self.assertEqual(measured['honcho_experiment']['state'], 'unavailable')
            self.assertIn({'path': 'files', 'bytes': 1000, 'complete': True}, result['state_folders'])
            self.assertEqual(result['docker_logs'], {'max_size_per_file': '10m', 'max_files_per_container': 3})

    @unittest.skipIf(os.geteuid() == 0, 'root reads every folder')
    def test_unreadable_folder_is_reported_as_a_lower_bound(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'open.bin').write_bytes(b'x' * 10)
            (root / 'closed').mkdir(); (root / 'closed/hidden.bin').write_bytes(b'x' * 99)
            (root / 'closed').chmod(0)
            try:
                self.assertEqual(measure(root), (10, False))
            finally:
                (root / 'closed').chmod(0o700)


if __name__ == '__main__':
    unittest.main()
