"""Switch an owned synthetic installation to real model answers; Telegram stays mocked.

Only after the owner authorizes using the operating installation's model route
beside it. The fixture's `cliproxy-api` becomes the model relay: it still serves
the Telegram mock, and forwards chat completions to the operating provider
through one dedicated internal bridge network, swapping the fixture's client
keys for the operating installation's scoped keys. With `--honcho real`, the
fixture's Honcho meter runs the production meter: real reasoning through the
relay, paid embeddings through its own egress network, counted in the operating
installation's shared spending ledger. No OAuth file, login or refresh process
is copied or started, and no service publishes a port.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
from tools.paths import ROOT
from tools.acceptance.telegram_rehearsal import validate_fixture
from tools.acceptance.model_relay import DEFAULT_REQUEST_LIMIT, MAX_REQUEST_LIMIT

PROVIDER = 'nocheh-cliproxy-api-1'


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, text=True, capture_output=True)


def operating(installation, model):
    """The operating installation's provider and Honcho state, never its secrets' values."""
    from tools.operations.installation.configuration import load
    from tools.operations.provider.provider import login_kind, login_state
    if not login_state(installation, login_kind(model))['login_present']:
        raise ValueError(login_kind(model)+'_subscription_login_required')
    if docker('inspect', '--format', '{{.State.Running}}', PROVIDER, check=False).stdout.strip() != 'true':
        raise ValueError('operating_provider_not_running')
    keys = installation/'provider/keys'
    honcho = Path(load(installation).get('NOCHEH_HONCHO_STATE_DIR') or installation/'honcho')
    for path in (keys/'hermes.key', keys/'honcho.key', honcho/'ledger', honcho/'temporary_embedding_key'):
        if not path.exists():
            raise ValueError('operating_state_missing:'+path.name)
    return keys, honcho


def transform(manifest, directory, keys, honcho, bridge, limit, real_honcho, model='claude-sonnet-5-5'):
    """Rewrite the executable fixture manifest; pure so it can be checked offline."""
    project = manifest['name']
    for service in manifest['services'].values():
        environment = service.get('environment')
        if isinstance(environment, dict):
            if 'NOCHEH_MODEL' in environment:
                environment['NOCHEH_MODEL'] = model
            for key in environment:  # Honcho's reasoning configurations; embeddings keep their own model.
                if key.endswith('_MODEL_CONFIG__MODEL') and not key.startswith('EMBEDDING_'):
                    environment[key] = model
    relay = manifest['services']['cliproxy-api']
    relay['command'] = ['/fixture/tools/acceptance/model_relay.py']
    relay['environment'] = {'NOCHEH_INSTALLATION_FIXTURE': '1', 'NOCHEH_REAL_MODEL_AUTHORIZED': '1', 'PYTHONPATH': '/fixture:/app', 'NOCHEH_MODEL': model,
                            'NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT': str(limit),
                            **({'NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED': '1'} if limit > DEFAULT_REQUEST_LIMIT else {})}
    mounts = {'/fixture/tools/__init__.py': ROOT/'tools/__init__.py', '/fixture/tools/paths.py': ROOT/'tools/paths.py',
              '/fixture/tools/acceptance/model_relay.py': ROOT/'tools/acceptance/model_relay.py',
              '/fixture/tools/acceptance/telegram_mock.py': ROOT/'tools/acceptance/telegram_mock.py',
              '/fixture-keys': directory/'state/provider/keys', '/existing-provider': keys}
    relay['volumes'] = [mount for mount in relay['volumes'] if mount['target'] not in mounts and mount['target'] != '/fixture/provider.py']
    relay['volumes'] += [{'type': 'bind', 'source': str(source), 'target': target, 'read_only': True} for target, source in mounts.items()]
    relay['networks'] = {**(relay.get('networks') or {}), 'existing-model': None}
    relay['healthcheck'] = {'test': ['CMD', '/app/.venv/bin/python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8317/healthz')"],
                            'interval': '5s', 'retries': 30}
    manifest['networks']['existing-model'] = {'name': bridge, 'external': True}
    meter = manifest['services']['honcho-provider-gateway']
    if real_honcho:
        meter['command'] = ['python', '/fixture/services/honcho/meter.py']
        meter['environment'] = {key: value for key, value in meter['environment'].items() if key != 'NOCHEH_INSTALLATION_FIXTURE'}
        meter['environment'].update(PYTHONPATH='/fixture', NOCHEH_MODEL=model)
        meter['volumes'] = [mount for mount in meter['volumes'] if mount['target'] not in ('/fixture/provider.py', '/ledger', '/fixture/tools/__init__.py')]
        meter['volumes'] += [{'type': 'bind', 'source': str(honcho/'ledger'), 'target': '/ledger'},
                             {'type': 'bind', 'source': str(ROOT/'tools/__init__.py'), 'target': '/fixture/tools/__init__.py', 'read_only': True}]
        manifest['secrets']['temporary_embedding_key'] = {'file': str(honcho/'temporary_embedding_key')}
        meter['networks'] = {**(meter.get('networks') or {}), 'honcho-egress': None}
        manifest['networks']['honcho-egress'] = {'name': project+'-honcho-egress', 'internal': False}
    else:
        # A real model with scripted Honcho still needs the validated shape: an
        # egress network attached to the meter alone, which the mock never uses.
        meter['networks'] = {**(meter.get('networks') or {}), 'honcho-egress': None}
        manifest['networks']['honcho-egress'] = {'name': project+'-honcho-egress', 'internal': False}
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--installation', type=Path, default=ROOT/'data/local',
                        help='State folder of the operating installation whose model route is borrowed')
    parser.add_argument('--honcho', choices=('real', 'fixture'), default='fixture')
    parser.add_argument('--model', default='claude-sonnet-5-5', help='Reasoning model the operating provider serves')
    parser.add_argument('--request-limit', type=int, default=DEFAULT_REQUEST_LIMIT)
    parser.add_argument('--authorized', action='store_true', help='The owner authorized this route and the parallel stack')
    args = parser.parse_args()
    if not args.authorized:
        raise SystemExit('owner_authorization_required')
    if not 1 <= args.request_limit <= MAX_REQUEST_LIMIT:
        raise SystemExit('invalid_request_limit')
    directory = args.directory.resolve()
    info = json.loads((directory/'fixture.json').read_text())
    manifest = json.loads((directory/'compose.json').read_text())
    project = validate_fixture(directory, info, manifest)
    keys, honcho = operating(args.installation.resolve(), args.model)
    bridge = project+'-existing-model'
    if docker('network', 'inspect', bridge, check=False).returncode:
        docker('network', 'create', '--internal', '--label', 'nocheh.fixture='+project, bridge)
    if bridge not in docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', PROVIDER).stdout:
        docker('network', 'connect', bridge, PROVIDER)
    (directory/('compose.before-real-model-'+str(time.time_ns())+'.json')).write_text(json.dumps(manifest))
    before = manifest
    manifest = transform(json.loads(json.dumps(manifest)), directory, keys, honcho, bridge, args.request_limit, args.honcho == 'real', args.model)
    for path in (directory/'compose.json', directory/'installation/docker-compose.yml'):
        path.write_text(json.dumps(manifest));path.chmod(0o600)
    (directory/'route-preflight.json').write_text(json.dumps({'project': project, 'authorized_existing_model_route': True,
        'model': args.model, 'honcho': args.honcho, 'request_limit': args.request_limit, 'bridge': bridge, 'at': time.time()}, indent=2)+'\n')
    command = ['docker', 'compose', '-p', project, '-f', str(directory/'compose.json')]
    subprocess.run(command+['config', '--quiet'], check=True)
    # The relay first, then every service whose definition changed (the model setting).
    changed = [name for name in manifest['services'] if name != 'cliproxy-api' and manifest['services'][name] != before['services'].get(name)]
    subprocess.run(command+['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'cliproxy-api'], check=True)
    if changed:
        subprocess.run(command+['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', *changed], check=True)
    print(json.dumps({'real_model': True, 'project': project, 'model': args.model, 'honcho': args.honcho,
                      'request_limit': args.request_limit, 'recreated': ['cliproxy-api', *changed]}), flush=True)


if __name__ == '__main__':
    main()
