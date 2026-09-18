"""Exercise accounting cleanup and real pinned monitor restart without networking."""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import reset_accounting as reset

MARKER = 'SYNTHETIC_PRIVATE_CONVERSATION_c319e00c'


def check(action):
    root = Path('/fixture')
    if (root / 'fixture.json').read_text() != 'nocheh-reset-accounting-fixture-v1\n':
        raise ValueError('fixture_marker_required')
    path = root / 'usage.sqlite'
    if action == 'locked':
        try:
            reset.sanitize(path)
        except RuntimeError as error:
            if str(error) == 'accounting_writer_still_running':
                return {'live_monitor_excluded': True}
            raise
        raise AssertionError('running monitor did not exclude reset')
    if action == 'seed':
        with sqlite3.connect(path) as db:
            reset.schema(db)
            assert db.execute('SELECT count(*) FROM usage_events').fetchone()[0] == 0
            db.execute('''INSERT INTO usage_events(event_hash,timestamp_ms,timestamp,model,provider,executor_type,
                input_tokens,output_tokens,total_tokens,cache_input_mode,normalized_uncached_input_tokens,
                normalized_total_input_tokens,normalized_cache_read_tokens,normalized_cache_creation_tokens,
                fail_body,fail_summary,response_metadata_json,raw_json,created_at_ms)
                VALUES(?,1789680000000,'2026-09-18T00:00:00Z','fixture-model','openai','codex',410,80,490,
                    'included_in_input',410,410,0,0,?,?,?,?,1789680000000)''',
                       ('synthetic-reset-event', MARKER, MARKER, json.dumps({'private': MARKER}),
                        json.dumps({'tokens': {'cache_input_mode': 'included_in_input', 'total_tokens': 490}, 'private': MARKER})))
            db.execute("INSERT INTO dead_letter_events(payload,error,created_at_ms) VALUES(?,?,1789680000000)", (MARKER, MARKER))
            db.execute("INSERT INTO model_prices(model,prompt_per_1m,completion_per_1m,cache_per_1m,updated_at_ms) VALUES('fixture-model',0.123456789,2.5,0.25,1789680000000)")
            db.execute("INSERT INTO settings(key,value,updated_at_ms) VALUES('fixture_saved_preference','saved',1789680000000)")
        with sqlite3.connect(root / 'budget.sqlite') as db:
            db.execute('CREATE TABLE reservations(id TEXT, cost INTEGER)')
            db.execute("INSERT INTO reservations VALUES('conservative-spending',17)")
        return {'synthetic_seeded': True}
    if action == 'sanitize':
        first = reset.sanitize(path)
        reset.sanitize(path)
        return {**first, 'repeat_passed': True}
    if action == 'verify':
        with sqlite3.connect(path) as db:
            assert db.execute("SELECT input_tokens,output_tokens,total_tokens FROM usage_events WHERE event_hash='synthetic-reset-event'").fetchone() == (410, 80, 490)
            assert db.execute("SELECT prompt_per_1m FROM model_prices WHERE model='fixture-model'").fetchone() == (0.123456789,)
            assert db.execute("SELECT value FROM settings WHERE key='fixture_saved_preference'").fetchone() == ('saved',)
            assert db.execute('SELECT count(*) FROM dead_letter_events').fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM usage_monitoring_event_search_v1 WHERE usage_monitoring_event_search_v1 MATCH 'c31'").fetchone() == (0,)
            rows = db.execute('SELECT fail_body,fail_summary,response_metadata_json,raw_json FROM usage_events').fetchall()
            assert MARKER not in json.dumps(rows)
        with sqlite3.connect(root / 'budget.sqlite') as db:
            assert db.execute('SELECT cost FROM reservations').fetchone() == (17,)
        for suffix in ('', '-wal', '-shm', '-journal'):
            file = Path(str(path) + suffix)
            if file.is_file():
                assert MARKER.encode() not in file.read_bytes(), file.name
        return {'accounting_and_settings_preserved': True, 'spending_ledger_preserved': True, 'content_absent': True}
    raise ValueError('invalid_fixture_action')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', choices=('locked', 'seed', 'sanitize', 'verify'))
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--monitor-image')
    parser.add_argument('--checks-image')
    args = parser.parse_args()
    if args.check:
        print(json.dumps(check(args.check)))
        return
    if not all((args.directory, args.monitor_image, args.checks_image)):
        parser.error('directory and both images are required')
    root = args.directory.resolve()
    root.mkdir(mode=0o700, exist_ok=False)
    (root / 'fixture.json').write_text('nocheh-reset-accounting-fixture-v1\n')
    project = 'nocheh-reset-accounting-' + uuid.uuid4().hex[:12]
    environment = {**os.environ, 'NOCHEH_RESET_FIXTURE_PROJECT': project, 'NOCHEH_RESET_FIXTURE_STATE': str(root),
                   'NOCHEH_RESET_MONITOR_IMAGE': args.monitor_image, 'NOCHEH_RESET_CHECKS_IMAGE': args.checks_image,
                   'NOCHEH_RESET_UID': str(os.getuid()), 'NOCHEH_RESET_GID': str(os.getgid())}
    command = ['docker', 'compose', '-p', project, '-f', str(Path(__file__).with_name('reset-accounting-compose.yml'))]

    def run(*arguments, capture=False):
        result = subprocess.run(command + list(arguments), env=environment, check=True, text=True,
                                stdout=subprocess.PIPE if capture else None)
        return result.stdout

    def verify(action):
        return json.loads(run('run', '--rm', '--no-deps', '--pull', 'never', 'checks', '--check', action, capture=True))

    try:
        config = json.loads(run('config', '--format', 'json', capture=True))
        assert all(service['network_mode'] == 'none' and not service.get('ports') for service in config['services'].values())
        run('up', '-d', '--no-build', '--wait', 'monitor')
        locked = verify('locked')
        run('stop', 'monitor')
        verify('seed')
        cleaned = verify('sanitize')
        verify('verify')
        run('up', '-d', '--no-build', '--wait', 'monitor')
        # Allow native migration/rollup workers to observe the retained event.
        time.sleep(5)
        run('stop', 'monitor')
        restored = verify('verify')
        report = {'passed': True, 'project': project, 'provider_calls': 0, 'network': 'none',
                  'live_state_changed': False, 'monitor_restart': True, **locked, **cleaned, **restored}
        (root / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    finally:
        run('--profile', 'checks', 'down', '--volumes')


if __name__ == '__main__':
    main()
