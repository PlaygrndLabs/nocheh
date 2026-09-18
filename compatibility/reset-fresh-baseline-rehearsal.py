"""Exercise erased-to-fresh initialization and the empty-baseline gate."""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import (configuration, reset_acceptance, reset_accounting, reset_baseline, reset_boundary,
                     reset_erasure, reset_initialization, reset_inventory, reset_ownership,
                     reset_preservation, reset_protocol, reset_quiescence)
from scripts.store_recovery import StoreRecovery

MARKER = 'SYNTHETIC_PRE_RESET_CONTENT_4b382f4e'
POSTGRES_PASSWORD = '1' * 64
INNGEST_PASSWORD = '5' * 64
BOOTSTRAP = r'''
import pg from 'pg';
import {digest} from './dist/src/archive.js';
import {initialize} from './dist/src/database.js';
const config={host:'nocheh-postgres',user:'nocheh',database:'nocheh',password:process.env.POSTGRES_PASSWORD};
const pool=new pg.Pool(config);await initialize(pool);
await pool.query("INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,payload,payload_hash,original_text,search_text) VALUES($1,'fixture-source','telegram','fixture','42','1','1','live','telegram_update',$2,$3,$4,$5)",
 ['a'.repeat(64),Buffer.from('{}'),digest('{}'),Buffer.from(process.env.PRIVATE_MARKER),process.env.PRIVATE_MARKER]);
await pool.query("INSERT INTO derived_artifacts(id,event_id,kind,content,provenance,search_text) VALUES($1,$2,'runtime_context',$3,'{}',$4)",
 ['b'.repeat(64),'a'.repeat(64),Buffer.from(process.env.PRIVATE_MARKER),process.env.PRIVATE_MARKER]);
await pool.query("INSERT INTO memory_spaces(id,overrides) VALUES('-10',$1)",
 [JSON.stringify({mode:'filtered',sources:['42'],privacy_instructions:'Only fixture facts.'})]);
await pool.end();'''


def output(arguments, environment=None):
    return subprocess.check_output(arguments, env=environment, text=True, stderr=subprocess.DEVNULL)


def seed_accounting(path):
    schema = (Path(__file__).parent / 'fixtures/cpamp-reset-schema.sql').read_text()
    with sqlite3.connect(path) as db:
        db.executescript(schema); reset_accounting.schema(db)
        db.execute('''INSERT INTO usage_events(event_hash,timestamp_ms,timestamp,model,provider,executor_type,
            input_tokens,output_tokens,total_tokens,cache_input_mode,normalized_uncached_input_tokens,
            normalized_total_input_tokens,normalized_cache_read_tokens,normalized_cache_creation_tokens,
            fail_body,fail_summary,response_metadata_json,raw_json,created_at_ms)
            VALUES(?,1789680000000,'2026-09-18T00:00:00Z','fixture-model','openai','codex',410,80,490,
            'included_in_input',410,410,0,0,?,?,?,?,1789680000000)''',
            ('synthetic-erasure-event', MARKER, MARKER, json.dumps({'private': MARKER}), json.dumps({'private': MARKER})))
        db.execute("INSERT INTO settings(key,value,updated_at_ms) VALUES('saved','yes',1789680000000)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True); parser.add_argument('--services-image', required=True)
    args = parser.parse_args(); directory = args.directory.resolve(); directory.mkdir(mode=0o700, exist_ok=False)
    state, memory = directory / 'state', directory / 'memory'; state.mkdir(); memory.mkdir()
    for relative in ('files', 'spool', 'workflows/redis', 'admin/reset', 'admin/tools', 'hermes/profiles',
                     'provider/auth', 'provider/monitor'):
        (state / relative).mkdir(parents=True)
    (state / 'files/original').write_text(MARKER); (state / 'spool/observation').write_text(MARKER)
    (state / 'hermes/auth.json').write_text('SYNTHETIC_LOGIN_RETAINED')
    custom = state / 'hermes/profiles/research'; custom.mkdir()
    (custom / 'config.yaml').write_text('{}\n')
    (custom / 'nocheh-owner-profile.json').write_text('{"scope":"owner"}\n')
    (state / 'provider/auth/token').write_text('SYNTHETIC_CREDENTIAL_RETAINED')
    seed_accounting(state / 'provider/monitor/usage.sqlite')
    (memory / 'ledger').mkdir(); (memory / 'ledger/spend').write_text('SYNTHETIC_SPENDING_RETAINED')
    (memory / 'honcho.env').write_text('SYNTHETIC_HONCHO_SETUP_RETAINED')
    values = dict(configuration.DEFAULTS)
    values.update(NOCHEH_STORAGE_LAYOUT='legacy', TELEGRAM_ENABLED='false', TELEGRAM_OWNER_ID='42',
        TELEGRAM_GROUP_IDS='-10', NOCHEH_MODEL='fixture-model', POSTGRES_PASSWORD=POSTGRES_PASSWORD,
        SERVICE_TOKEN='2' * 64, INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
        INNGEST_POSTGRES_PASSWORD=INNGEST_PASSWORD,
        NOCHEH_ARCHIVE_PASSWORD=hashlib.sha256(b'archive-fixture').hexdigest(),
        NOCHEH_DERIVED_PASSWORD=hashlib.sha256(b'derived-fixture').hexdigest(),
        NOCHEH_CONTROL_PASSWORD=hashlib.sha256(b'control-fixture').hexdigest(), NOCHEH_HONCHO_ENABLED='true',
        NOCHEH_HONCHO_STATE_DIR=str(memory))
    config = state / '.env'; configuration.write_env(config, values); loaded = configuration.load(state); configuration.validate(loaded)

    project = 'nocheh-reset-fresh-' + uuid.uuid4().hex[:12]
    store_passwords = {name: hashlib.sha256((name + '-fixture').encode()).hexdigest()
                       for name in ('archive', 'derived', 'control')}
    service_environment = {'PGHOST': 'nocheh-postgres', 'PGPASSWORD': POSTGRES_PASSWORD,
        'NOCHEH_DATA_DIR': '/data', 'NOCHEH_STORAGE_LAYOUT': 'original-only-v1',
        'NOCHEH_ARCHIVE_PASSWORD': store_passwords['archive'],
        'NOCHEH_DERIVED_PASSWORD': store_passwords['derived'],
        'NOCHEH_CONTROL_PASSWORD': store_passwords['control'],
        'INNGEST_POSTGRES_PASSWORD': INNGEST_PASSWORD}
    compose = {'name': project, 'services': {
        'nocheh-postgres': {'image': 'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'command': ['postgres', '-c', 'cluster_name=nocheh-reset-fresh-fixture'],
            'environment': {'POSTGRES_USER': 'nocheh', 'POSTGRES_DB': 'nocheh', 'POSTGRES_PASSWORD': POSTGRES_PASSWORD},
            'volumes': ['nocheh_database:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U nocheh -d nocheh'], 'interval': '1s', 'retries': 30}},
        'inngest-redis': {'image': 'redis:7.4.11-bookworm@sha256:71da9275c5f3fcb97d0fa0c8c5b36cc995327265420f17a04bfd544f458059f7',
            'volumes': [str(state / 'workflows/redis') + ':/data'],
            'command': ['redis-server', '--appendonly', 'yes', '--appendfsync', 'always', '--save', ''],
            'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '1s', 'retries': 30}},
        'honcho-postgres': {'profiles': ['honcho'],
            'image': 'pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f',
            'environment': {'POSTGRES_DB': 'honcho_experiment', 'POSTGRES_USER': 'experiment',
                            'POSTGRES_PASSWORD': 'synthetic-honcho-password'},
            'volumes': ['honcho_database:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U experiment -d honcho_experiment'],
                            'interval': '1s', 'retries': 30}},
        'honcho-redis': {'profiles': ['honcho'],
            'image': 'redis:8.2@sha256:7d1e4ce8b9395088377ab382d1f6cfdbd13b3690795198a0399ab8d683064d6d',
            'volumes': ['honcho_redis:/data'],
            'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '1s', 'retries': 30}},
        'bootstrap': {'image': args.services_image, 'entrypoint': ['node', '--input-type=module', '-e', BOOTSTRAP],
            'profiles': ['checks'], 'environment': {'POSTGRES_PASSWORD': POSTGRES_PASSWORD, 'PRIVATE_MARKER': MARKER},
            'depends_on': {'nocheh-postgres': {'condition': 'service_healthy'}}},
        'nocheh-reset-setup': {'image': args.services_image, 'profiles': ['reset'],
            'user': f'{os.getuid()}:{os.getgid()}', 'command': ['node', 'dist/src/stores/reset-setup-cli.js', '/reset/setup.json'],
            'environment': {**service_environment, 'NOCHEH_RESET_SETUP': '1'},
            'volumes': [str(state / 'spool') + ':/data/spool:ro', str(state / 'admin/reset') + ':/reset:ro']},
        'nocheh-reset-baseline': {'image': args.services_image, 'profiles': ['reset'],
            'user': f'{os.getuid()}:{os.getgid()}', 'command': ['node', 'dist/src/stores/reset-baseline-cli.js', '/reset/setup.json'],
            'environment': {**{key: value for key, value in service_environment.items()
                               if key not in ('PGPASSWORD', 'INNGEST_POSTGRES_PASSWORD')},
                            'NOCHEH_RESET_BASELINE': '1'},
            'volumes': [str(state / 'admin/reset') + ':/reset:ro']},
        'nocheh-reset-state': {'image': args.services_image, 'profiles': ['reset'],
            'user': f'{os.getuid()}:{os.getgid()}', 'command': ['node', 'dist/src/stores/reset-state-cli.js'],
            'environment': {**{key: value for key, value in service_environment.items()
                               if key not in ('PGPASSWORD', 'INNGEST_POSTGRES_PASSWORD')},
                            'NOCHEH_RESET_STATE': '1'}}},
        'volumes': {'nocheh_database': {},
                    'honcho_database': {'external': True, 'name': project + '_honcho_database'},
                    'honcho_redis': {'external': True, 'name': project + '_honcho_redis'}},
        'networks': {'default': {'internal': True}}}
    compose_file = directory / 'compose.json'; compose_file.write_text(json.dumps(compose))
    command = ['docker', 'compose', '-p', project, '-f', str(compose_file)]; environment = dict(os.environ)
    expected_volume_names = []
    external_volume_names = [project + '_honcho_database', project + '_honcho_redis']
    try:
        for name in external_volume_names:
            subprocess.run(['docker', 'volume', 'create', name], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(command + ['--profile', 'honcho', 'up', '-d', '--no-build', '--wait',
                                   'nocheh-postgres', 'inngest-redis', 'honcho-postgres', 'honcho-redis'],
                       env=environment, check=True)
        subprocess.run(command + ['run', '--rm', '--no-deps', 'bootstrap'], env=environment, check=True)
        redis_id = output(command + ['ps', '-q', 'inngest-redis'], environment).strip()
        subprocess.run(['docker', 'exec', redis_id, 'redis-cli', 'SET', 'pre-reset', MARKER], check=True,
                       stdout=subprocess.DEVNULL)
        honcho_redis_id = output(command + ['--profile', 'honcho', 'ps', '-q', 'honcho-redis'], environment).strip()
        honcho_postgres_id = output(command + ['--profile', 'honcho', 'ps', '-q', 'honcho-postgres'], environment).strip()
        subprocess.run(['docker', 'exec', honcho_redis_id, 'redis-cli', 'SET', 'pre-reset', MARKER], check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'exec', honcho_postgres_id, 'psql', '-U', 'experiment', '-d', 'honcho_experiment',
                        '-c', "CREATE TABLE pre_reset(value text); INSERT INTO pre_reset VALUES ('synthetic')"],
                       check=True, stdout=subprocess.DEVNULL)

        rendered = json.loads(output(command + ['--profile', 'honcho', 'config', '--format', 'json'], environment)); identifiers = output(command + ['--profile', 'honcho', 'ps', '-a', '-q'], environment).split()
        containers = [json.loads(line) for line in output(['docker', 'inspect', '--format', reset_inventory.CONTAINER_FORMAT, *identifiers], environment).splitlines()]
        volumes = []
        for service, target in reset_inventory.VOLUME_TARGETS.items():
            if service not in rendered['services']: continue
            container = next(row for row in containers if row['service'] == service)
            mount = next(row for row in container['mounts'] if row.get('Destination') == target)
            logical = next(row['source'] for row in rendered['services'][service]['volumes'] if row['target'] == target)
            name = rendered['volumes'][logical]['name']; expected_volume_names.append(name)
            record = json.loads(output(['docker', 'volume', 'inspect', '--format', reset_inventory.VOLUME_FORMAT, name], environment))
            volumes.append({**record, 'service': service, 'target': target, 'configured_name': name,
                            'authority': 'explicit_configuration_and_installation_mount'})
            assert mount['Name'] == name
        blockers = []; paths = reset_inventory.files(state, memory, config, blockers)
        preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'executable': False,
            'content_copied': False, 'blockers': blockers, 'containers': containers, 'volumes': volumes,
            'paths': paths, 'external_archives': [], 'installation': {'root': str(directory), 'state': str(state),
                'memory_state': str(memory), 'project': project, 'storage_layout': 'legacy',
                'config_path': str(config), 'configuration_sha256': hashlib.sha256(reset_protocol.canonical(loaded)).hexdigest(),
                'state_anchor': reset_inventory.entry(state, 'retain_root', 'fixture')}}

        def inspect():
            current = json.loads(json.dumps(preflight)); present = set(output(['docker', 'ps', '-a', '-q', '--no-trunc'], environment).split())
            current['containers'] = [json.loads(output(['docker', 'inspect', '--format', reset_inventory.CONTAINER_FORMAT, row['id']], environment))
                                     for row in preflight['containers'] if row['id'] in present]
            return current

        recovery = StoreRecovery(command, environment); review = reset_ownership.prepare(preflight)
        with recovery.maintenance(), reset_protocol.locked(state) as journal:
            journal.create(preflight, str(uuid.uuid4()))
            quiescence = {'format': 'nocheh-reset-quiescence-v1', 'reset_id': journal.value['reset_id'],
                'preflight_sha256': journal.value['preflight_sha256'],
                'binding_sha256': reset_protocol.fingerprint(reset_quiescence.binding(preflight)),
                'fences_absent_at_start': True,
                'containers': [{'id': row['id'], 'service': row['service'], 'state': row['state'],
                                'restart_policy': row['restart_policy']} for row in preflight['containers']]}
            reset_protocol.atomic(journal.directory / 'quiescence.json', quiescence, create=True)
            for step in reset_protocol.STEPS[:3]: journal.complete(step, 'c' * 64)
            reset_protocol.atomic(journal.directory / 'settlement.json', {'synthetic': True}, create=True)
            reset_quiescence.fence(state, journal.value['reset_id'])
            reset_preservation.freeze(journal, preflight, recovery, review, inspect=inspect)
            result = reset_erasure.erase(journal, preflight, recovery, review, inspect=inspect, environment=environment)
            assert result['phase'] == 'erased' and journal.value['steps'][-1]['step'] == 'erased'
        assert not any(Path(path).exists() for path in (state / 'files', state / 'workflows/redis'))
        assert not (state / 'spool/observation').exists() and (state / 'spool/.restore-inactive').is_file()
        assert (state / 'hermes/auth.json').read_text() == 'SYNTHETIC_LOGIN_RETAINED'
        assert (state / 'provider/auth/token').read_text() == 'SYNTHETIC_CREDENTIAL_RETAINED'
        assert (memory / 'ledger/spend').read_text() == 'SYNTHETIC_SPENDING_RETAINED'
        assert all(subprocess.run(['docker', 'inspect', identifier], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode for identifier in identifiers)
        assert all(subprocess.run(['docker', 'volume', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode for name in expected_volume_names)
        environment.update(NOCHEH_HONCHO_ENABLED='true', NOCHEH_MODEL='fixture-model')
        with reset_protocol.locked(state) as journal:
            initialized = reset_initialization.initialize(journal, preflight, environment=environment, command=command)
            setup = reset_protocol.read(journal.directory / 'setup.json')
            assert configuration.load(state)['NOCHEH_STORAGE_LAYOUT'] == 'original-only-v1'
            assert setup['snapshot']['layout'] == 'original-only-v1'
            assert setup['snapshot']['configuration']['sharing_rules'] == [{
                **setup['snapshot']['configuration']['sharing_rules'][0],
                'sources': ['42'], 'destination': '-10', 'enabled': True,
                'mode': 'filtered', 'instructions': 'Only fixture facts.'}]
            assert len(setup['snapshot']['configuration']['runtime_profiles']) == 1
            assert setup['snapshot']['configuration']['runtime_profiles'][0]['name'] == 'research'
            baseline = reset_baseline.verify(journal, preflight, environment=environment, command=command)
            assert initialized['phase'] == 'initialized' and baseline['phase'] == 'empty_baseline'
            assert journal.value['steps'][-1]['step'] == 'empty_baseline'
            calls = []
            boundary = reset_boundary.discard_backlog(journal, preflight,
                '123456:synthetic-reset-fixture-not-a-real-token', environment=environment, command=command,
                transport=lambda _token: calls.append(1) or True)
            assert boundary['phase'] == 'telegram_boundary' and boundary['reused'] is False and calls == [1]
            assert journal.value['steps'][-1]['step'] == 'telegram_boundary'
            acceptance = reset_acceptance.activate(journal, preflight, environment=environment,
                                                    command=command)
            assert acceptance['phase'] == 'acceptance_running'
            assert acceptance['restart_ownership'] is False and journal.value['steps'][-1]['step'] == 'telegram_boundary'
        current_ids = output(command + ['--profile', 'honcho', 'ps', '-a', '-q'], environment).split()
        assert set(current_ids).isdisjoint(identifiers) and len(current_ids) == 4
        current = [json.loads(line) for line in output(['docker', 'inspect', '--format', reset_inventory.CONTAINER_FORMAT,
                                                        *current_ids], environment).splitlines()]
        assert {row['service'] for row in current} == {'nocheh-postgres', 'inngest-redis', 'honcho-postgres', 'honcho-redis'}
        assert all(row['restart_policy'] == {'Name': 'no', 'MaximumRetryCount': 0} and row['state'] == 'running' for row in current)
        assert all(not (state / 'admin/reset' / name).exists() for name in reset_baseline.PRIVATE)
        assert all(not (state / name).exists() for name in reset_quiescence.FENCES)
        assert (state / 'hermes/auth.json').read_text() == 'SYNTHETIC_LOGIN_RETAINED'
        assert (state / 'provider/auth/token').read_text() == 'SYNTHETIC_CREDENTIAL_RETAINED'
        assert (memory / 'ledger/spend').read_text() == 'SYNTHETIC_SPENDING_RETAINED'
        report = {'passed': True, 'project': project, 'phase': 'acceptance_mode_fixture',
                  'old_containers_removed': len(containers), 'old_volumes_removed': len(volumes),
                  'fresh_services': len(current), 'fresh_volumes': initialized['volumes'],
                  'archive_rows': baseline['archive_rows'], 'derived_rows': baseline['derived_rows'],
                  'inngest_postgres_relations': baseline['inngest_postgres_relations'],
                  'inngest_redis_keys': baseline['inngest_redis_keys'],
                  'honcho_postgres_relations': baseline['honcho_postgres_relations'],
                  'honcho_redis_keys': baseline['honcho_redis_keys'],
                  'private_reset_artifacts_retired': True, 'inactive_fences_released': True,
                  'source_layout': 'legacy', 'target_layout': 'original-only-v1',
                  'legacy_sharing_rules': 1, 'legacy_custom_profiles': 1,
                  'post_retirement_state_revalidated': True, 'fixture_boundary_calls': 1,
                  'credentials_login_and_spending_retained': True,
                  'restart_ownership': False, 'fresh_acceptance': False,
                  'runtime_activated': False, 'network': 'internal only',
                  'provider_calls': 0, 'live_state_changed': False}
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps(report))
    finally:
        subprocess.run(command + ['--profile', 'checks', '--profile', 'reset', '--profile', 'honcho',
                                   'down', '--volumes'], env=environment, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name in external_volume_names:
            subprocess.run(['docker', 'volume', 'rm', name], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__': main()
