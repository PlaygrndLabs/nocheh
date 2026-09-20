"""Exercise the complete preservation gate with real PostgreSQL and SQLite."""
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
from scripts import (configuration, reset_accounting, reset_inventory,
                     reset_ownership, reset_preservation, reset_protocol, reset_quiescence)

MARKER = 'SYNTHETIC_PRIVATE_RESET_PRESERVATION_5b27867c'
PASSWORD = 'synthetic-reset-preservation-only'
QUERY = r'''(async()=>{const fs=require('node:fs');const pg=require('pg');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const pool=new pg.Pool({host:'nocheh-db',user:'nocheh',database:request.store==='control'?'nocheh_control':'nocheh',password:process.env.NOCHEH_RESET_DB_PASSWORD});
const result=await pool.query(request.sql),results=Array.isArray(result)?result:[result];
const selected=results.find(value=>value.rows&&value.rows.length);if(!selected)throw Error('query_result_missing');
process.stdout.write(JSON.stringify(Object.values(selected.rows[0])[0]));await pool.end();})().catch(()=>process.exit(1));'''
BOOTSTRAP = r'''
import pg from 'pg';
import {canonical,digest} from './dist/src/archive.js';
import {initializeStoreDatabases,connectStores} from './dist/src/stores/connections.js';
const config={host:'nocheh-db',user:'nocheh',database:'nocheh',password:process.env.NOCHEH_RESET_DB_PASSWORD};
const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords);
const policy={enabled:false,owner_id:'42',group_ids:['-10']};
await stores.control.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)",[JSON.stringify(policy),digest(canonical(policy))]);
await stores.control.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
await stores.control.query("INSERT INTO projects(id,name,description,state,revision) VALUES($1,'Fixture project','Saved setup','active',1)",['a'.repeat(64)]);
await stores.archive.query("INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,payload,payload_hash,original_text,search_text) VALUES($1,'fixture-source','telegram','fixture','42','1','1','live','telegram_update',$2,$3,$4,$5)",
 ['b'.repeat(64),Buffer.from('{}'),digest('{}'),Buffer.from(process.env.NOCHEH_RESET_PRIVATE_MARKER),process.env.NOCHEH_RESET_PRIVATE_MARKER]);
await stores.derived.query("INSERT INTO derived_artifacts(id,kind,content,content_hash,provenance,source_revision,input_hash,producer,producer_version,configuration_hash,operation_id,operation_reference) VALUES($1,'runtime_context',$2,$3,'{}','1',$3,'fixture','1',$3,'fixture-operation',$4)",
 ['c'.repeat(64),Buffer.from(process.env.NOCHEH_RESET_PRIVATE_MARKER),digest(process.env.NOCHEH_RESET_PRIVATE_MARKER),JSON.stringify({store:'control',kind:'operation',id:'fixture-operation',generation:'11111111-1111-4111-8111-111111111111',input_hash:digest('fixture')})]);
await stores.close();'''


class Recovery:
    def assert_maintenance(self):
        return None

    def query(self, store, sql):
        result = subprocess.run(['node', '--input-type=commonjs', '-e', QUERY],
            input=json.dumps({'store': store, 'sql': sql}), text=True, capture_output=True,
            env={**os.environ, 'NOCHEH_RESET_DB_PASSWORD': PASSWORD}, timeout=30)
        if result.returncode or len(result.stdout) > reset_protocol.LIMIT:
            raise RuntimeError('fixture_database_query_failed')
        return result.stdout


def seed_accounting(path):
    schema = Path('/app/compatibility/fixtures/cpamp-reset-schema.sql').read_text()
    with sqlite3.connect(path) as db:
        db.executescript(schema); reset_accounting.schema(db)
        db.execute('''INSERT INTO usage_events(event_hash,timestamp_ms,timestamp,model,provider,executor_type,
            input_tokens,output_tokens,total_tokens,cache_input_mode,normalized_uncached_input_tokens,
            normalized_total_input_tokens,normalized_cache_read_tokens,normalized_cache_creation_tokens,
            fail_body,fail_summary,response_metadata_json,raw_json,created_at_ms)
            VALUES(?,1789680000000,'2026-09-18T00:00:00Z','fixture-model','openai','codex',410,80,490,
            'included_in_input',410,410,0,0,?,?,?,?,1789680000000)''',
            ('synthetic-preservation-event', MARKER, MARKER, json.dumps({'private': MARKER}),
             json.dumps({'tokens': {'total_tokens': 490}, 'private': MARKER})))
        db.execute("INSERT INTO settings(key,value,updated_at_ms) VALUES('fixture_saved_preference','saved',1789680000000)")
        db.execute('INSERT INTO dead_letter_events(payload,error,created_at_ms) VALUES(?,?,1789680000000)', (MARKER, MARKER))


def fixture_check(root):
    if (root / 'fixture.json').read_text() != 'nocheh-reset-preservation-fixture-v1\n':
        raise ValueError('fixture_marker_required')
    state, memory = root / 'state', root / 'memory'; state.mkdir(); memory.mkdir()
    for relative in ('files', 'spool', 'workflows', 'admin/reset', 'admin/tools', 'hermes/profiles',
                     'provider/auth', 'provider/monitor'):
        (state / relative).mkdir(parents=True)
    (state / 'files/original').write_text(MARKER); (state / 'spool/observation').write_text(MARKER)
    (state / 'hermes/auth.json').write_text('SYNTHETIC_LOGIN_RETAINED')
    (state / 'provider/auth/token').write_text('SYNTHETIC_CREDENTIAL_RETAINED')
    accounting = state / 'provider/monitor/usage.sqlite'; seed_accounting(accounting)
    (memory / 'ledger').mkdir(); (memory / 'ledger/spend').write_text('SYNTHETIC_SPENDING_RETAINED')
    (memory / 'honcho.env').write_text('SYNTHETIC_HONCHO_SETUP_RETAINED')
    values = dict(configuration.DEFAULTS)
    values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false', TELEGRAM_OWNER_ID='42',
        TELEGRAM_GROUP_IDS='-10', NOCHEH_MODEL='fixture-model', POSTGRES_PASSWORD='1' * 64,
        SERVICE_TOKEN='2' * 64, INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
        INNGEST_POSTGRES_PASSWORD='5' * 64, NOCHEH_ARCHIVE_PASSWORD='6' * 64,
        NOCHEH_DERIVED_PASSWORD='7' * 64, NOCHEH_CONTROL_PASSWORD='8' * 64,
        NOCHEH_HONCHO_STATE_DIR=str(memory))
    config = state / '.env'; configuration.write_env(config, values); loaded = configuration.load(state); configuration.validate(loaded)
    blockers = []; paths = reset_inventory.files(state, memory, config, blockers)
    preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'executable': False,
        'content_copied': False, 'blockers': blockers, 'containers': [], 'volumes': [], 'paths': paths,
        'external_archives': [], 'installation': {'root': str(root), 'state': str(state), 'memory_state': str(memory),
            'project': 'fixture', 'storage_layout': 'original-only-v1', 'config_path': str(config),
            'configuration_sha256': hashlib.sha256(reset_protocol.canonical(loaded)).hexdigest(),
            'state_anchor': reset_inventory.entry(state, 'retain_root', 'fixture')}}
    recovery = Recovery(); review = reset_ownership.prepare(preflight)
    with reset_protocol.locked(state) as journal:
        journal.create(preflight, str(uuid.uuid4()))
        for step in reset_protocol.STEPS[:3]: journal.complete(step, 'd' * 64)
        reset_quiescence.fence(state, journal.value['reset_id'])
        result = reset_preservation.freeze(journal, preflight, recovery, review, inspect=lambda: preflight)
        assert reset_preservation.freeze(journal, preflight, recovery, review, inspect=lambda: preflight) == result
        assert journal.value['steps'][-1]['step'] == 'preservation_frozen'
        public = json.dumps(result); assert MARKER not in public and 'SYNTHETIC_CREDENTIAL' not in public
        assert MARKER not in (journal.directory / 'configuration.json').read_text()
        for candidate in journal.directory.iterdir():
            if candidate.is_file(): assert MARKER.encode() not in candidate.read_bytes()
    with sqlite3.connect(accounting) as db:
        assert db.execute("SELECT input_tokens,total_tokens FROM usage_events WHERE event_hash='synthetic-preservation-event'").fetchone() == (410, 490)
        assert db.execute("SELECT value FROM settings WHERE key='fixture_saved_preference'").fetchone() == ('saved',)
        assert db.execute('SELECT count(*) FROM dead_letter_events').fetchone() == (0,)
    for suffix in ('', '-wal', '-shm', '-journal'):
        candidate = Path(str(accounting) + suffix)
        if candidate.is_file(): assert MARKER.encode() not in candidate.read_bytes()
    for candidate in (state / 'files/original', state / 'spool/observation'):
        assert candidate.read_text() == MARKER
    assert (memory / 'ledger/spend').read_text() == 'SYNTHETIC_SPENDING_RETAINED'
    return {'passed': True, 'phase': result['phase'], 'configuration_records': result['configuration_records'],
            'preserved_roots': result['preserved_roots'], 'erasure_targets': result['erasure_targets'],
            'accounting_preserved': True, 'source_and_derivative_canaries_excluded_from_configuration': True,
            'original_files_not_erased': True, 'provider_calls': 0, 'live_state_changed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true'); parser.add_argument('--directory', type=Path)
    parser.add_argument('--management-image')
    args = parser.parse_args()
    if args.check:
        print(json.dumps(fixture_check(Path('/fixture')))); return
    if not args.directory or not args.management_image:
        parser.error('directory and management-image are required')
    directory = args.directory.resolve(); directory.mkdir(mode=0o700, exist_ok=False)
    (directory / 'fixture.json').write_text('nocheh-reset-preservation-fixture-v1\n')
    project = 'nocheh-reset-preservation-' + uuid.uuid4().hex[:12]
    environment = {**os.environ, 'NOCHEH_RESET_PRESERVATION_PROJECT': project}
    compose = {'name': project, 'services': {
        'nocheh-db': {'image': 'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'command': ['postgres', '-c', 'cluster_name=nocheh-reset-preservation-fixture'],
            'environment': {'POSTGRES_USER': 'nocheh', 'POSTGRES_DB': 'nocheh', 'POSTGRES_PASSWORD': PASSWORD},
            'volumes': ['database:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U nocheh -d nocheh'], 'interval': '2s', 'retries': 30}},
        'bootstrap': {'image': args.management_image, 'user': str(os.getuid()) + ':' + str(os.getgid()),
            'entrypoint': ['node', '--input-type=module', '-e', BOOTSTRAP],
            'profiles': ['checks'], 'environment': {'NOCHEH_RESET_DB_PASSWORD': PASSWORD, 'NOCHEH_RESET_PRIVATE_MARKER': MARKER},
            'depends_on': {'nocheh-db': {'condition': 'service_healthy'}}},
        'checks': {'image': args.management_image, 'user': str(os.getuid()) + ':' + str(os.getgid()),
            'entrypoint': ['python3', '/app/compatibility/reset-preservation-rehearsal.py', '--check'],
            'profiles': ['checks'], 'read_only': True, 'tmpfs': ['/tmp:rw,nosuid,nodev,size=128m,mode=1777'],
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'environment': {'NOCHEH_RESET_DB_PASSWORD': PASSWORD, 'PYTHONDONTWRITEBYTECODE': '1'},
            'volumes': [str(directory) + ':/fixture'],
            'depends_on': {'nocheh-db': {'condition': 'service_healthy'}}}},
        'volumes': {'database': {}}, 'networks': {'default': {'internal': True}}}
    file = directory / 'compose.json'; file.write_text(json.dumps(compose)); command = ['docker', 'compose', '-p', project, '-f', str(file)]
    try:
        rendered = json.loads(subprocess.check_output(command + ['config', '--format', 'json'], env=environment, text=True))
        assert rendered['networks']['default']['internal'] is True and all(not service.get('ports') for service in rendered['services'].values())
        subprocess.run(command + ['up', '-d', '--no-build', '--wait', 'nocheh-db'], env=environment, check=True)
        subprocess.run(command + ['run', '--rm', '--no-deps', 'bootstrap'], env=environment, check=True)
        output = subprocess.check_output(command + ['run', '--rm', '--no-deps', 'checks'], env=environment, text=True)
        report = json.loads(output); report.update(project=project, network='internal only', management_image=args.management_image)
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps(report))
    finally:
        subprocess.run(command + ['--profile', 'checks', 'down', '--volumes'], env=environment, check=True)


if __name__ == '__main__': main()
