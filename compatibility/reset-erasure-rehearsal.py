"""Exercise resumable scoped file/container/volume erasure in fresh Compose."""
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
from scripts import (configuration, reset_accounting, reset_erasure, reset_inventory,
                     reset_ownership, reset_preservation, reset_protocol, reset_quiescence)
from scripts.store_recovery import StoreRecovery

MARKER = 'SYNTHETIC_ERASURE_CONTENT_6c62520d'
POSTGRES_PASSWORD = '1' * 64
INNGEST_PASSWORD = '5' * 64
BOOTSTRAP = r'''
import pg from 'pg';
import {canonical,digest} from './dist/src/archive.js';
import {initializeStoreDatabases,connectStores} from './dist/src/stores/connections.js';
const config={host:'nocheh-postgres',user:'nocheh',database:'nocheh',password:process.env.POSTGRES_PASSWORD};
const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords);
const policy={enabled:false,owner_id:'42',group_ids:['-10']};
await stores.control.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)",[JSON.stringify(policy),digest(canonical(policy))]);
await stores.control.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
await stores.archive.query("INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,payload,payload_hash,original_text,search_text) VALUES($1,'fixture-source','telegram','fixture','42','1','1','live','telegram_update',$2,$3,$4,$5)",
 ['a'.repeat(64),Buffer.from('{}'),digest('{}'),Buffer.from(process.env.PRIVATE_MARKER),process.env.PRIVATE_MARKER]);
await stores.derived.query("INSERT INTO derived_artifacts(id,kind,content,content_hash,provenance,source_revision,input_hash,producer,producer_version,configuration_hash,operation_id,operation_reference) VALUES($1,'runtime_context',$2,$3,'{}','1',$3,'fixture','1',$3,'fixture-operation',$4)",
 ['b'.repeat(64),Buffer.from(process.env.PRIVATE_MARKER),digest(process.env.PRIVATE_MARKER),JSON.stringify({store:'control',kind:'operation',id:'fixture-operation',generation:'11111111-1111-4111-8111-111111111111',input_hash:digest('fixture')})]);
await stores.close();'''


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
    parser.add_argument('--directory', type=Path, required=True); parser.add_argument('--management-image', required=True)
    args = parser.parse_args(); directory = args.directory.resolve(); directory.mkdir(mode=0o700, exist_ok=False)
    state, memory = directory / 'state', directory / 'memory'; state.mkdir(); memory.mkdir()
    for relative in ('files', 'spool', 'workflows/redis', 'admin/reset', 'admin/tools', 'hermes/profiles',
                     'provider/auth', 'provider/monitor'):
        (state / relative).mkdir(parents=True)
    (state / 'files/original').write_text(MARKER); (state / 'spool/observation').write_text(MARKER)
    (state / 'workflows/redis/appendonly.aof').write_text(MARKER)
    (state / 'hermes/auth.json').write_text('SYNTHETIC_LOGIN_RETAINED')
    (state / 'provider/auth/token').write_text('SYNTHETIC_CREDENTIAL_RETAINED')
    seed_accounting(state / 'provider/monitor/usage.sqlite')
    (memory / 'ledger').mkdir(); (memory / 'ledger/spend').write_text('SYNTHETIC_SPENDING_RETAINED')
    (memory / 'honcho.env').write_text('SYNTHETIC_HONCHO_SETUP_RETAINED')
    values = dict(configuration.DEFAULTS)
    values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false', TELEGRAM_OWNER_ID='42',
        TELEGRAM_GROUP_IDS='-10', NOCHEH_MODEL='fixture-model', POSTGRES_PASSWORD=POSTGRES_PASSWORD,
        SERVICE_TOKEN='2' * 64, INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
        INNGEST_POSTGRES_PASSWORD=INNGEST_PASSWORD,
        NOCHEH_ARCHIVE_PASSWORD=hashlib.sha256(b'archive-fixture').hexdigest(),
        NOCHEH_DERIVED_PASSWORD=hashlib.sha256(b'derived-fixture').hexdigest(),
        NOCHEH_CONTROL_PASSWORD=hashlib.sha256(b'control-fixture').hexdigest(),
        NOCHEH_HONCHO_STATE_DIR=str(memory))
    config = state / '.env'; configuration.write_env(config, values); loaded = configuration.load(state); configuration.validate(loaded)

    project = 'nocheh-reset-erasure-' + uuid.uuid4().hex[:12]
    compose = {'name': project, 'services': {
        'nocheh-postgres': {'image': 'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'command': ['postgres', '-c', 'cluster_name=nocheh-reset-erasure-fixture'],
            'environment': {'POSTGRES_USER': 'nocheh', 'POSTGRES_DB': 'nocheh', 'POSTGRES_PASSWORD': POSTGRES_PASSWORD},
            'volumes': ['nocheh_database:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U nocheh -d nocheh'], 'interval': '1s', 'retries': 30}},
        'inngest-postgres': {'image': 'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'environment': {'POSTGRES_USER': 'inngest', 'POSTGRES_DB': 'inngest', 'POSTGRES_PASSWORD': INNGEST_PASSWORD},
            'volumes': ['inngest_database:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U inngest -d inngest'], 'interval': '1s', 'retries': 30}},
        'fixture-app': {'image': args.management_image, 'entrypoint': ['/bin/true'],
            'volumes': [str(state / 'files') + ':/data/files']},
        'bootstrap': {'image': args.management_image, 'entrypoint': ['node', '--input-type=module', '-e', BOOTSTRAP],
            'profiles': ['checks'], 'environment': {'POSTGRES_PASSWORD': POSTGRES_PASSWORD, 'PRIVATE_MARKER': MARKER},
            'depends_on': {'nocheh-postgres': {'condition': 'service_healthy'}}}},
        'volumes': {'nocheh_database': {}, 'inngest_database': {}},
        'networks': {'default': {'internal': True}}}
    compose_file = directory / 'compose.json'; compose_file.write_text(json.dumps(compose))
    command = ['docker', 'compose', '-p', project, '-f', str(compose_file)]; environment = dict(os.environ)
    sentinel_volume = project + '-unrelated'; sentinel_container = project + '-unrelated'
    expected_volume_names = []
    try:
        subprocess.run(command + ['up', '-d', '--no-build', '--wait', 'nocheh-postgres', 'inngest-postgres'], env=environment, check=True)
        subprocess.run(command + ['create', 'fixture-app'], env=environment, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(command + ['run', '--rm', '--no-deps', 'bootstrap'], env=environment, check=True)
        subprocess.run(['docker', 'volume', 'create', sentinel_volume], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'create', '--name', sentinel_container, '--network', 'none',
                        '--mount', 'type=volume,source=' + sentinel_volume + ',target=/sentinel',
                        '--entrypoint', '/bin/true', args.management_image], check=True, stdout=subprocess.DEVNULL)

        rendered = json.loads(output(command + ['config', '--format', 'json'], environment)); identifiers = output(command + ['ps', '-a', '-q'], environment).split()
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
                'memory_state': str(memory), 'project': project, 'storage_layout': 'original-only-v1',
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
            for step in reset_protocol.STEPS[:3]: journal.complete(step, 'c' * 64)
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
        assert subprocess.run(['docker', 'inspect', sentinel_container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        assert subprocess.run(['docker', 'volume', 'inspect', sentinel_volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        report = {'passed': True, 'project': project, 'phase': 'erased', 'containers_removed': len(containers),
                  'volumes_removed': len(volumes), 'inngest_postgres_volume_removed': True,
                  'workflow_redis_bind_erased': True, 'inactive_fences_retained': True,
                  'credentials_login_and_spending_retained': True, 'unrelated_container_and_volume_retained': True,
                  'network': 'internal only', 'provider_calls': 0, 'live_state_changed': False}
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps(report))
    finally:
        subprocess.run(command + ['--profile', 'checks', 'down', '--volumes'], env=environment, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'rm', '-f', sentinel_container], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'volume', 'rm', sentinel_volume], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__': main()
