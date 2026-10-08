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


    def test_stop_ends_retention_before_the_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); order = directory / 'order'

            def executable(name, body):
                path = directory / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o700)

            executable('docker-entrypoint.sh', 'trap \'echo database >> "$ORDER"; exit 0\' TERM; while :; do sleep 0.1; done')
            executable('pg_isready', 'exit 0')
            # Bootstrap returns at once; the retention worker stays running until stopped.
            executable('node', 'case "$1" in *retention.js) trap \'echo retention >> "$ORDER"; exit 0\' TERM; '
                               'touch "$ORDER.started"; while :; do sleep 0.1; done;; esac; exit 0')
            environment = {**os.environ, 'PATH': str(directory) + os.pathsep + os.environ['PATH'],
                           'ORDER': str(order), 'POSTGRES_PASSWORD': 'synthetic'}
            wrapper = subprocess.Popen(['/bin/sh', str(ENTRYPOINT), 'postgres'], env=environment)
            try:
                for _ in range(100):
                    if Path(str(order) + '.started').exists(): break
                    subprocess.run(['sleep', '0.1'])
                wrapper.terminate(); wrapper.wait(timeout=10)
            finally:
                if wrapper.poll() is None: wrapper.kill()
            self.assertEqual(order.read_text().split(), ['retention', 'database'])


if __name__ == '__main__':
    unittest.main()
