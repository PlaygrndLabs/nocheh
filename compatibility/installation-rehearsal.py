"""Run original-only services together on freshly owned, synthetic Compose state.

Candidate images are mandatory. Production definitions are rendered first, then
external inference transports are replaced explicitly. Core networks have no
egress; an optional localhost dashboard relay has no state or credentials. There
is no Telegram login, live mount, or production image mutation.
The fixture's memory attachment is database seeding, never live acceptance proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.configuration import initialize, write_env, compose_command, compose_environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--services-image', required=True)
    parser.add_argument('--native-image', required=True)
    parser.add_argument('--honcho-image', required=True)
    parser.add_argument('--keep', action='store_true', help='Retain only this synthetic installation for diagnosis/preview')
    parser.add_argument('--preview-port', type=int, help='Publish only the owner dashboard on this available localhost port')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    directory = args.directory.resolve()
    if args.preview_port:
        if not args.keep or not 1024 <= args.preview_port <= 65535:
            raise ValueError('preview_requires_keep_and_unprivileged_port')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', args.preview_port))
    if directory.exists():
        raise ValueError('new_fixture_directory_required')
    directory.mkdir(mode=0o700)
    state = directory / 'state'
    installation = directory / 'installation'
    (installation / 'compatibility').mkdir(parents=True)
    (installation / 'deploy').mkdir()
    shutil.copyfile(root / 'compatibility/upstreams.lock.json', installation / 'compatibility/upstreams.lock.json')
    (installation / 'deploy/original-only-compose.yml').write_text('services: {}\n')
    project = 'nocheh-installation-' + uuid.uuid4().hex[:12]
    config = initialize(state)
    token = secrets.token_hex(32)
    config.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', NOCHEH_HONCHO_ENABLED='true',
        NOCHEH_HONCHO_STATE_DIR=str(state / 'honcho'), NOCHEH_MEMORY_TOKEN=token,
        NOCHEH_HONCHO_DATABASE_VOLUME=project + '_honcho_database', NOCHEH_HONCHO_REDIS_VOLUME=project + '_honcho_redis',
        COMPOSE_PROJECT_NAME=project, NOCHEH_AGENT_NETWORK=project + '-agent', NOCHEH_MEMORY_NETWORK=project + '-memory',
        TELEGRAM_OWNER_ID='123', TELEGRAM_GROUP_IDS='-10042,-10043', TELEGRAM_ENABLED='false', NOCHEH_PORT='18990')
    if args.preview_port:
        config['NOCHEH_DASHBOARD_PORT'] = str(args.preview_port)
    write_env(state / '.env', config)
    memory = state / 'honcho'
    (memory / 'ledger').mkdir(parents=True, mode=0o700)
    password = secrets.token_hex(32)
    for name, value in {'internal_token': token, 'database_password': password,
                        'temporary_embedding_key': 'synthetic-no-provider', 'honcho.Dockerfile': '# fixture uses an explicit image\n'}.items():
        path = memory / name
        path.write_text(value)
        path.chmod(0o600)
    native = {'DB_CONNECTION_URI': f'postgresql+psycopg://experiment:{password}@honcho-postgres:5432/honcho_experiment',
        'CACHE_URL': 'redis://honcho-redis:6379/0?suppress=true', 'CACHE_ENABLED': 'true', 'AUTH_USE_AUTH': 'false',
        'PYTHON_DOTENV_DISABLED': '1', 'HONCHO_CONFIG_TOML_DISABLED': '1', 'LLM_OPENAI_API_KEY': token,
        'EXPERIMENT_INTERNAL_TOKEN': token, 'DERIVER_WORKERS': '1', 'DERIVER_FLUSH_ENABLED': 'true',
        'DERIVER_REPRESENTATION_BATCH_WORK_UNIT_TARGET_TOKENS': '0', 'DERIVER_REPRESENTATION_BATCH_MAX_AGE_SECONDS': '1',
        'DERIVER_POLLING_STARTUP_JITTER_SECONDS': '0', 'DERIVER_POLLING_BACKOFF_ENABLED': 'false',
        'DREAM_ENABLED': 'false', 'SUMMARY_ENABLED': 'true', 'EMBED_MESSAGES': 'true', 'LOG_LEVEL': 'WARNING',
        'EMBEDDING_VECTOR_DIMENSIONS': '1536', 'EMBEDDING_MODEL_CONFIG__TRANSPORT': 'openai',
        'EMBEDDING_MODEL_CONFIG__MODEL': 'text-embedding-3-small'}
    prefixes = ['DERIVER_MODEL_CONFIG', 'SUMMARY_MODEL_CONFIG', 'DREAM_DEDUCTION_MODEL_CONFIG', 'DREAM_INDUCTION_MODEL_CONFIG']
    prefixes += [f'DIALECTIC_LEVELS__{level}__MODEL_CONFIG' for level in ('minimal', 'low', 'medium', 'high', 'max')]
    for prefix in prefixes + ['EMBEDDING_MODEL_CONFIG']:
        native.update({prefix + '__OVERRIDES__BASE_URL': 'http://honcho-provider-gateway:8790/v1',
                       prefix + '__OVERRIDES__API_KEY_ENV': 'EXPERIMENT_INTERNAL_TOKEN'})
        if prefix != 'EMBEDDING_MODEL_CONFIG':
            native.update({prefix + '__TRANSPORT': 'openai', prefix + '__MODEL': 'gpt-5.6-sol'})
    native['DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE'] = 'json_object'
    for level in ('minimal', 'low', 'medium', 'high', 'max'):
        native[f'DIALECTIC_LEVELS__{level}__MAX_OUTPUT_TOKENS'] = '2500'
    write_env(memory / 'honcho.env', native)
    write_env(memory / 'meter.env', {})
    env = compose_environment(state)
    owned = []
    command = None

    def run(arguments, **options):
        return subprocess.run(command + arguments, env=env, check=True, **options)

    try:
        images = {}
        for role, value in [('services', args.services_image), ('native', args.native_image), ('honcho', args.honcho_image)]:
            images[role] = json.loads(subprocess.check_output(['docker', 'image', 'inspect', value], text=True))[0]['Id']
        for key in ('NOCHEH_HONCHO_DATABASE_VOLUME', 'NOCHEH_HONCHO_REDIS_VOLUME'):
            volume = config[key]
            if subprocess.run(['docker', 'volume', 'inspect', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                raise ValueError('fixture_volume_already_exists')
            subprocess.run(['docker', 'volume', 'create', '--label', 'nocheh.fixture=' + project, volume], check=True, stdout=subprocess.DEVNULL)
            owned.append(volume)
        rendered = json.loads(subprocess.check_output(compose_command(state, project) + ['config', '--format', 'json'], env=env, text=True))
        selected = {'nocheh-postgres', 'nocheh-store-bootstrap', 'nocheh-app', 'nocheh-security', 'inngest-redis', 'inngest-server',
            'hermes-runtime', 'hermes-agent-launcher', 'chatgpt-speech', 'cliproxy-api', 'honcho-postgres', 'honcho-redis',
            'honcho-api', 'honcho-deriver', 'honcho-provider-gateway', 'nocheh-dashboard', 'nocheh-executor'}
        rendered['services'] = {name: value for name, value in rendered['services'].items() if name in selected}
        for network in rendered['networks'].values():
            network['internal'] = True
        for name, service in rendered['services'].items():
            service.pop('build', None)
            service.pop('ports', None)
            service.pop('profiles', None)
            service['restart'] = 'no'
            if name in ('nocheh-app', 'nocheh-security', 'nocheh-store-bootstrap'):
                service['image'] = images['services']
                service['entrypoint'] = []
                if name == 'nocheh-app':
                    service['command'] = ['node', 'dist/src/main.js']
                # Allow the capture policy while keeping the native Telegram
                # adapter disabled: fixture observations enter /v1/ingest.
                if name != 'nocheh-store-bootstrap':
                    service['environment']['TELEGRAM_ENABLED'] = 'true'
            if name in ('nocheh-dashboard', 'nocheh-executor'):
                service['image'] = images['services']
                service['environment']['NOCHEH_INSTALLATION_ROOT'] = str(installation)
                service['volumes'] = [mount for mount in service['volumes'] if mount.get('source') != str(root)]
                service['volumes'].append({'type': 'bind', 'source': str(installation), 'target': str(installation), 'read_only': True})
            if name in ('hermes-runtime', 'hermes-agent-launcher', 'chatgpt-speech'):
                service['image'] = images['native']
            if name == 'hermes-agent-launcher':
                service['environment']['NOCHEH_TURN_IMAGE'] = images['native']
            if name in ('honcho-api', 'honcho-deriver'):
                service['image'] = images['honcho']
            if name in ('nocheh-postgres', 'honcho-postgres'):
                service['command'] = ['postgres', '-c', 'shared_buffers=32MB', '-c', 'max_connections=80',
                                      '-c', 'cluster_name=nocheh-installation-fixture']
                service['mem_limit'] = '512m'
        mock = rendered['services']['cliproxy-api']
        mock.update(image=images['honcho'], user='0:0', entrypoint=['/app/.venv/bin/python'],
            command=['/fixture/provider.py', 'provider'], environment={'NOCHEH_INSTALLATION_FIXTURE': '1', 'PYTHONPATH': '/app'},
            volumes=[{'type': 'bind', 'source': str(root / 'compatibility/installation-provider.py'), 'target': '/fixture/provider.py', 'read_only': True}],
            healthcheck={'test': ['CMD', '/app/.venv/bin/python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8317/healthz')"], 'interval': '3s', 'retries': 30})
        meter = rendered['services']['honcho-provider-gateway']
        meter['command'] = ['python', '/fixture/provider.py', 'meter']
        meter['environment']['NOCHEH_INSTALLATION_FIXTURE'] = '1'
        meter['volumes'].append({'type': 'bind', 'source': str(root / 'compatibility/installation-provider.py'), 'target': '/fixture/provider.py', 'read_only': True})
        # Assert isolation on the final executable definitions, not an unused overlay.
        assert all(network.get('internal') is True for network in rendered['networks'].values())
        for name, service in rendered['services'].items():
            assert not service.get('ports') and service.get('network_mode') != 'host'
            for mount in service.get('volumes', []):
                if mount['type'] == 'bind':
                    path = Path(mount['source'])
                    assert path.is_relative_to(directory) or mount.get('read_only') and path.is_relative_to(root) or (str(path) == '/var/run/docker.sock' and name in ('hermes-agent-launcher', 'nocheh-dashboard', 'nocheh-executor')), (name, path)
        if args.preview_port:
            add_preview(rendered, args.preview_port, images['services'])
        file = directory / 'compose.json'
        file.write_text(json.dumps(rendered))
        file.chmod(0o600)
        shutil.copyfile(file, installation / 'docker-compose.yml')
        (installation / 'docker-compose.yml').chmod(0o600)
        command = ['docker', 'compose', '-p', project, '-f', str(file)]
        (directory / 'fixture.json').write_text(json.dumps({'project': project, 'images': images, 'directory': str(directory)}, indent=2))
        run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '300'])
        verify(directory, command, env, project, images)
    except Exception as error:
        code = str(error) if isinstance(error, AssertionError) and str(error).startswith('fixture_gate_timeout:') else 'fixture_operation_failed'
        (directory / 'failure.json').write_text(json.dumps({'passed': False, 'project': project,
            'error_type': type(error).__name__, 'code': code, 'live_acceptance': False}, indent=2) + '\n')
        raise
    finally:
        if command and not args.keep:
            subprocess.run(command + ['down', '--volumes'], env=env, check=True)
        if not args.keep:
            for volume in reversed(owned):
                subprocess.run(['docker', 'volume', 'rm', volume], check=True, stdout=subprocess.DEVNULL)


def add_preview(rendered, port, image):
    # Docker Desktop does not publish ports for an entirely internal network.
    # This unprivileged relay owns the sole external network attachment. It has
    # no state/credentials and can proxy only the fixed synthetic dashboard.
    rendered['services']['nocheh-dashboard'].pop('ports', None)
    rendered['networks']['preview'] = {'name': rendered['name'] + '-preview'}
    script = f"const net=require('node:net');net.createServer(client=>{{const upstream=net.connect({port},'nocheh-dashboard');client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream);upstream.pipe(client);}}).listen({port},'0.0.0.0');"
    rendered['services']['fixture-preview'] = {'image': image, 'entrypoint': ['node', '-e'], 'command': [script],
        'user': '1000:1000', 'init': True, 'restart': 'no', 'read_only': True, 'cap_drop': ['ALL'],
        'security_opt': ['no-new-privileges:true'], 'mem_limit': '128m', 'pids_limit': 32,
        'networks': {'default': None, 'preview': None},
        'ports': [{'target': port, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]}


def verify(directory, command, env, project, images):
    state = directory / 'state'
    gates = []
    def run(arguments, **options):
        return subprocess.run(command + arguments, env=env, check=True, **options)

    def query(database, sql):
        return subprocess.check_output(command + ['exec', '-T', 'nocheh-postgres', 'psql', '-X', '-q', '-A', '-t',
            '-v', 'ON_ERROR_STOP=1', '-U', 'nocheh', '-d', database, '-c', sql], env=env, text=True).strip()

    def http(path, body=None, service='nocheh-app', port=8780):
        script = """const [host,port,path,body]=process.argv.slice(1);const input=JSON.parse(body);
const response=await fetch('http://'+host+':'+port+path,{method:input===null?'GET':'POST',
headers:{Authorization:'Bearer '+process.env.SERVICE_TOKEN,'content-type':'application/json'},
...(input===null?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(240000)});
const result=await response.json();if(!response.ok)throw Error(JSON.stringify({status:response.status,result}));console.log(JSON.stringify(result));"""
        return json.loads(subprocess.check_output(command + ['exec', '-T', 'nocheh-app', 'node', '--input-type=module', '-e', script,
            service, str(port), path, json.dumps(body)], env=env, text=True))

    def wait(label, check, seconds=180):
        started = time.monotonic()
        deadline = started + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                observed = {'gate': label, 'passed': True, 'seconds': round(time.monotonic() - started, 3)}
                gates.append(observed)
                (directory / 'progress.json').write_text(json.dumps(gates, indent=2) + '\n')
                print(json.dumps(observed), flush=True)
                return value
            time.sleep(2)
        raise AssertionError('fixture_gate_timeout:' + label)

    wait('pipeline_registered', lambda: query('nocheh_control', "SELECT string_agg(family,',' ORDER BY family) FROM workflow_worker_registrations WHERE app='pipeline' AND seen_at>now()-interval '30 seconds'") == 'actions,browser,honcho,memory_review,preparation,schedules,telegram')
    wait('host_worker_registered', lambda: query('nocheh_control', "SELECT string_agg(family,',' ORDER BY family) FROM workflow_worker_registrations WHERE app='host' AND seen_at>now()-interval '30 seconds'") == 'imports,tools')
    # Seed only this fresh fixture's prerequisite. Never submit a fabricated
    # live report to the public verification endpoint or touch live control.
    assert query('nocheh_control', "SELECT current_setting('cluster_name')") == 'nocheh-installation-fixture'
    query('nocheh_control', "UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now(),acceptance='{\"fixture_only\":true,\"live_acceptance\":false}'::jsonb WHERE singleton")
    text = 'In this chat, the telescope mark means reviewed. Password: fixture-secret-ORCHID-2718'
    event = {'version': 1, 'key': 'installation-fixture:edited:1', 'origin': 'live', 'bot_id': 'synthetic',
        'kind': 'telegram_update', 'scope': '123', 'source_id': '1', 'revision': '2', 'occurred_at': None, 'text': text,
        'payload': {'update_id': 1, 'edited_message': {'message_id': 1, 'date': 1, 'edit_date': 2,
            'chat': {'id': 123, 'type': 'private'}, 'from': {'id': 123, 'is_bot': False}, 'text': text}}}
    accepted = http('/v1/ingest', event)
    assert accepted['state'] == 'spooled'
    wait('original_captured', lambda: query('nocheh_archive', 'SELECT count(*) FROM events') == '1')
    wait('guard_prepared', lambda: query('nocheh_derived', "SELECT count(*) FROM guard_sources WHERE state='ready'") != '0')
    wait('native_memory_ingested', lambda: query('nocheh_control', "SELECT count(*) FROM memory_ingestion_receipts WHERE state='done'") != '0', 300)
    wait('learned_convention_published', lambda: query('nocheh_derived', 'SELECT count(*) FROM learned_entries WHERE active_revision IS NOT NULL') != '0', 300)
    assert query('nocheh_control', "SELECT count(*) FROM dispatches WHERE state<>'suppressed' OR attempts<>0") == '0', 'edits must learn silently'
    assert http('/v1/ingest', event) == accepted
    wait('duplicate_spool_retired', lambda: not (state / 'spool/pending' / (accepted['id'] + '.json')).exists())
    assert query('nocheh_archive', 'SELECT count(*) FROM events') == '1'
    assert query('nocheh_derived', "SELECT count(*) FROM learned_versions v JOIN derived_artifacts d ON d.id=v.derived_id WHERE d.provenance->'learning'->>'uncertainty'='explicit'") != '0'
    wait('learning_refresh_settled', lambda: query('nocheh_control', "SELECT count(*) FROM guard_publications WHERE state='pending'") == '0')
    reaction = {'version': 1, 'key': 'installation-fixture:reaction:1', 'origin': 'live', 'bot_id': 'synthetic',
        'kind': 'telegram_update', 'scope': '123', 'source_id': 'reaction-one', 'revision': '1', 'occurred_at': None, 'text': None,
        'payload': {'update_id': 3, 'message_reaction': {'message_id': 1, 'date': 3, 'chat': {'id': 123, 'type': 'private'},
            'user': {'id': 123, 'is_bot': False}, 'old_reaction': [], 'new_reaction': [{'type': 'emoji', 'emoji': '🔭'}]}}}
    http('/v1/ingest', reaction)
    wait('reaction_state_learned', lambda: query('nocheh_derived', "SELECT count(*) FROM learned_entries WHERE kind='state' AND active_revision IS NOT NULL") != '0', 300)
    assert query('nocheh_control', "SELECT count(*) FROM dispatches WHERE state<>'suppressed' OR attempts<>0") == '0', 'reaction learning must remain silent'
    profile = http('/v1/runtime/profiles', {'name': 'installation-rehearsal', 'state': 'active', 'expected_revision': 0, 'operation_id': 'fixture-profile'})
    browser = {'scope': '123', 'profile': profile['id'], 'conversation': 'fixture-conversation', 'id': 'input-one',
        'revision': int(query('nocheh_control', 'SELECT epoch FROM guard_state WHERE singleton')),
        'text': 'Describe the synthetic telescope. Password: fixture-secret-ORCHID-2718', 'files': []}
    captured = http('/v1/browser/input', browser)
    context = {**browser, 'event_id': captured['event_id']}
    http('/v1/browser/admit', context)
    def browser_done():
        row = json.loads(query('nocheh_control', "SELECT json_build_object('state',state,'error',error_code) FROM managed_runs WHERE event_id='" + captured['event_id'] + "'"))
        if row['state'] in ('failed', 'interrupted', 'cancelled'):
            raise AssertionError('native_browser_failed:' + str(row['error']))
        return row['state'] == 'done'
    wait('native_browser_turn_completed', browser_done, 300)
    observed = http('/v1/browser/observe', context)
    assert observed['visible'] and observed['delivery'] and '[mock]' in observed['text']
    assert 'fixture-secret-ORCHID-2718' not in observed['text']
    assert http('/v1/browser/undelivered', {'profile': profile['id']})['items']
    delivery = http('/v1/browser/delivered', observed['delivery'])
    wait('browser_delivery_archived', lambda: query('nocheh_archive', "SELECT count(*) FROM events WHERE id='" + delivery['event_id'] + "'") == '1')
    assert not http('/v1/browser/undelivered', {'profile': profile['id']})['items']
    # Admission must remain available when every PostgreSQL store and the
    # workflow engine are stopped. Only fixture owners are affected.
    run(['stop', '-t', '30', 'inngest-server', 'nocheh-postgres'], stdout=subprocess.DEVNULL)
    delayed = {**event, 'key': 'installation-fixture:edited:outage', 'source_id': '2', 'text': 'Captured during the fixture outage.',
        'payload': {'update_id': 2, 'edited_message': {'message_id': 2, 'date': 3, 'edit_date': 4,
            'chat': {'id': 123, 'type': 'private'}, 'from': {'id': 123, 'is_bot': False}, 'text': 'Captured during the fixture outage.'}}}
    pending = http('/v1/ingest', delayed)
    assert pending['state'] == 'spooled' and (state / 'spool/pending' / (pending['id'] + '.json')).is_file()
    assert http('/v1/ingest', delayed) == pending
    # --no-deps bypasses Compose's PostgreSQL health dependency. Restore the
    # database first: the pinned Inngest process exits on connection refusal.
    run(['up', '-d', '--no-deps', '--no-build', '--wait', 'nocheh-postgres'], stdout=subprocess.DEVNULL)
    run(['up', '-d', '--no-deps', '--no-build', '--wait', 'inngest-server'], stdout=subprocess.DEVNULL)
    wait('outage_capture_recovered', lambda: query('nocheh_archive', "SELECT count(*) FROM events WHERE id='" + pending['id'] + "'") == '1')
    wait('outage_handoff_recovered', lambda: query('nocheh_control', "SELECT count(*) FROM source_intakes WHERE event_id='" + pending['id'] + "' AND state='ready'") == '1')
    wait('outage_memory_recovered', lambda: query('nocheh_control', "SELECT count(*) FROM memory_ingestion_receipts WHERE source_reference->>'id'='" + pending['id'] + "' AND state='done'") != '0', 300)
    stats = http('/fixture/stats', service='cliproxy-api', port=8317)
    assert stats['detector'] > 0 and stats['learning'] > 0 and stats['embeddings'] > 0 and stats['raw_canary_outside_detector'] == 0
    report = {'passed': True, 'project': project, 'images': images, 'provider': 'deterministic-fixture',
        'live_acceptance': False, 'external_provider_calls': 0, 'live_state_changed': False, 'stats': stats, 'gates': gates,
            'checks': ['production_composition_started', 'three_store_health', 'inngest_connected', 'host_worker_registered', 'original_captured',
            'guard_prepared', 'native_memory_ingested', 'learned_convention_published', 'edit_learning_silent', 'guarded_egress',
                'duplicate_capture_idempotent', 'native_browser_turn_completed', 'browser_recovery_and_delivery', 'database_and_workflow_outage_capture',
                'outage_capture_recovered', 'outage_handoff_recovered', 'outage_memory_recovered', 'reaction_state_learned', 'reaction_learning_silent']}
    (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)

if __name__ == '__main__':
    main()
