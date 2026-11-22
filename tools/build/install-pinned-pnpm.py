"""Install the pnpm that the pinned Hermes source locks in pm/lock.json, checked by its sha256.

Hermes's own installer (pm) refuses to run inside a Docker-stamped checkout, so the image's frontend build stages use
this instead. Usage: install-pinned-pnpm.py <hermes source> <install folder>. The folder gets pnpm's native executable
beside its package.json, as pm lays it out."""
import hashlib
import io
import json
import platform
import sys
import tarfile
import urllib.request
from pathlib import Path

source, folder = Path(sys.argv[1]), Path(sys.argv[2])
pin = json.loads((source / 'pm/lock.json').read_text())['packages']['pnpm']
machine = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine().lower()]
folder.mkdir(parents=True, exist_ok=True)
# The native executable's package (@pnpm/exe) carries everything pnpm needs; the JavaScript package is pm's fallback.
for artifact in [item for item in pin['artifacts']['linux-' + machine] if '/@pnpm/exe.' in item['url']]:
    with urllib.request.urlopen(artifact['url'], timeout=120) as response:
        body = response.read()
    if hashlib.sha256(body).hexdigest() != artifact['sha256']:
        raise SystemExit('pnpm artifact checksum mismatch: ' + artifact['url'])
    with tarfile.open(fileobj=io.BytesIO(body)) as archive:
        for member in archive.getmembers():
            if not member.name.startswith('package/') or not (member.isfile() or member.isdir()):
                continue
            member.name = member.name[len('package/'):]
            if member.name:
                archive.extract(member, folder, filter='data')
binary = folder / 'pnpm'
binary.chmod(0o755)
print(pin['version'], binary)
