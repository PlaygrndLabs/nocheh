"""The store wrapper must not terminate a still-recovering PostgreSQL process."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[1] / 'deploy/store-postgres-entrypoint.sh'


class StorePostgresEntrypointTests(unittest.TestCase):
    def run_wrapper(self, *, ready_after, database_command):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            count = directory / 'readiness-count'
            count.write_text('0')

            def executable(name, body):
                path = directory / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o700)

            executable('docker-entrypoint.sh', database_command)
            executable('pg_isready',
                       'n=$(cat "$READINESS_COUNT"); n=$((n + 1)); '
                       'echo "$n" > "$READINESS_COUNT"; '
                       f'[ "$n" -gt {ready_after} ]')
            for name in ('node', 'rm', 'touch', 'sleep'):
                executable(name, 'exit 0')
            environment = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH'],
                           'READINESS_COUNT': str(count), 'POSTGRES_PASSWORD': 'synthetic'}
            result = subprocess.run(['/bin/sh', str(ENTRYPOINT), 'postgres'], env=environment,
                                    capture_output=True, text=True, timeout=15)
            return result.returncode, int(count.read_text())

    def test_recovery_longer_than_old_300_poll_deadline_is_preserved(self):
        status, checks = self.run_wrapper(ready_after=350, database_command='/bin/sleep 8')
        self.assertEqual(status, 0)
        self.assertEqual(checks, 351)

    def test_exited_database_does_not_wait_forever(self):
        status, checks = self.run_wrapper(ready_after=10000, database_command='exit 7')
        self.assertNotEqual(status, 0)
        self.assertLess(checks, 10000)


if __name__ == '__main__':
    unittest.main()
