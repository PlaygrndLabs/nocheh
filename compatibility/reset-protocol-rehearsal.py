"""Run reset failure/restart contracts from built images without any network."""
import argparse
import json
import os
import re
import subprocess
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--management-image', required=True)
    parser.add_argument('--native-image', required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    directory.mkdir(mode=0o700)
    project = 'nocheh-reset-protocol-' + uuid.uuid4().hex[:12]
    root = Path(__file__).resolve().parents[1]
    environment = {**os.environ, 'NOCHEH_RESET_PROTOCOL_PROJECT': project,
                   'NOCHEH_RESET_PROTOCOL_MANAGEMENT_IMAGE': args.management_image,
                   'NOCHEH_RESET_PROTOCOL_NATIVE_IMAGE': args.native_image,
                   'NOCHEH_RESET_PROTOCOL_UID': str(os.getuid()), 'NOCHEH_RESET_PROTOCOL_GID': str(os.getgid())}
    command = ['docker', 'compose', '-p', project, '-f', str(root / 'compatibility/reset-protocol-compose.yml')]
    rendered = json.loads(subprocess.check_output(command + ['config', '--format', 'json'], env=environment, text=True))
    for service in rendered['services'].values():
        assert service['network_mode'] == 'none' and service['read_only'] is True
        assert not service.get('ports') and not service.get('volumes')
    images = {name: json.loads(subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{json .Id}}', image], text=True))
              for name, image in [('management', args.management_image), ('native', args.native_image)]}
    checks = {}
    try:
        for service in ('management', 'native'):
            result = subprocess.run(command + ['run', '--rm', '--no-deps', service], env=environment, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
            (directory / (service + '.log')).write_text(result.stdout)
            found = re.search(r'Ran (\d+) tests? in', result.stdout)
            if result.returncode or not found or not re.search(r'\nOK\s*$', result.stdout):
                print(result.stdout)
                raise RuntimeError('reset_protocol_fixture_failed')
            checks[service] = {'passed': int(found[1]), 'failed': 0, 'skipped': 0}
        report = {'passed': True, 'project': project, 'images': images, 'checks': checks,
                  'network': 'none', 'state_mounts': [], 'provider_calls': 0,
                  'telegram_requests': 0, 'live_state_changed': False}
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    finally:
        subprocess.run(command + ['down'], env=environment, check=True)


if __name__ == '__main__': main()
