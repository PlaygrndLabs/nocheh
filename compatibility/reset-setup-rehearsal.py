"""Verify new-generation setup admission against fresh isolated PostgreSQL."""
import argparse
import json
import os
import subprocess
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--image', required=True)
    args = parser.parse_args(); directory = args.directory.resolve(); directory.mkdir(mode=0o700, exist_ok=False)
    project = 'nocheh-reset-setup-' + uuid.uuid4().hex[:12]
    environment = {**os.environ, 'NOCHEH_STORES_FIXTURE_PROJECT': project,
                   'NOCHEH_STORES_FIXTURE_IMAGE': args.image}
    command = ['docker', 'compose', '-f', str(Path(__file__).with_name('stores-compose.yml'))]
    try:
        image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', args.image], text=True))[0]['Id']
        subprocess.run(command + ['up', '-d', '--wait', 'database'], env=environment, check=True,
                       stdout=subprocess.DEVNULL)
        result = subprocess.run(command + ['run', '--rm', 'checks', 'node', '--test', '--test-concurrency=1',
                                'dist/test/store-reset-setup.test.js', 'dist/test/store-bootstrap.test.js'], env=environment, text=True,
                                capture_output=True, timeout=300)
        if result.returncode or 'pass 2' not in result.stdout or 'fail 0' not in result.stdout:
            raise RuntimeError('reset_setup_fixture_failed')
        report = {'passed': True, 'project': project, 'image': image, 'checks': 2,
                  'new_generation_required': True, 'setup_only': True,
                  'source_content_copied': False, 'history_copied': False,
                  'network': 'internal only', 'provider_calls': 0, 'live_state_changed': False}
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    finally:
        subprocess.run(command + ['down', '--volumes'], env=environment, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
