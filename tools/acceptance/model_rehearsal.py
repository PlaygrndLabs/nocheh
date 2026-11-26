"""Collect real-model answers to synthetic Telegram memory cases for review.

Only Telegram stays simulated. The fixture's model service relays chat and
embedding requests to an owner-authorized provider from a private upstream file,
so Hermes, Honcho and the guard reason with a real model through the ordinary
custom-provider route. Delivery assertions are mechanical; answer quality is
graded by code checks against saved synthetic ground truth, and by the same
cheap model only where words alone cannot settle a fact. Each case also runs
in a fresh agent session, and each check that something stays hidden counts
only when its control, the same fact asked where it may be told, passed. One
cheap model answers every call, and the relay refuses any call past the spend
cap. This cannot mark live acceptance passed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
from urllib.parse import urlsplit
from tools.paths import ROOT
from tools.acceptance.telegram_mock import TOKEN
from tools.acceptance.telegram_rehearsal import archived_delivery, MODEL_EGRESS, TELEGRAM_SERVICE, wait_telegram_connected

CASES = ('reaction_removed', 'corrected_fact', 'private_isolation', 'topic_shared', 'group_isolation',
         'recall_after_restart', 'retired_fact')
UPSTREAM_TARGET = '/fixture/upstream.json'
# Two time zones whose dates always differ (UTC-12 and UTC+14). A chat starts one new session a day under one zone, so
# moving the owner's zone between them lets the same chat start a second new session in one run.
NEW_DAY_ZONES = ('Etc/GMT+12', 'Pacific/Kiritimati')
HERMES_PROFILES = '/workspace/data/local/hermes/profiles'
# Runs in the fixture's Hermes: lists each chat's session cursor, and with '1' moves each chat's day back and points it
# at a session that was never stored, so the next turn opens a new day's session with no earlier message to carry
# (daily_session.choose and start).
NEW_DAY = """import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);move=sys.argv[2]=='1';seen={}
for marker in root.rglob('space.json'):
    for cursor in marker.parent.glob('active-*.json'):
        value=json.loads(cursor.read_text());seen[str(cursor.relative_to(root))]=value.get('session_id')
        if move:
            value.update(session_id='nocheh-fixture-earlier-day',day='2000-01-01',last_active=0)
            temporary=cursor.with_suffix('.tmp');temporary.write_text(json.dumps(value));temporary.replace(cursor)
print(json.dumps(seen))"""
DIGITS = str.maketrans('۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789')
NAME = ('پرستو', 'نیلی', '72')
# What each case's answer must and must not say, the question for the model judge where words cannot settle it, and
# the control a must-not-tell check depends on.
CHECKS = {
    'reaction_removed': {'judge': 'Does the answer say that a star reaction was added to the Orang delivery report and later '
                         'removed, and does it avoid saying the report is approved now?'},
    'corrected_fact': {'mentions': ('18',)},
    'private_isolation': {'forbidden': NAME, 'control': 'recall_after_restart'},
    'topic_shared': {'mentions': ('18',)},
    'group_isolation': {'forbidden': ('18', '16'), 'control': 'topic_shared'},
    'recall_after_restart': {'mentions': NAME},
    'retired_fact': {'forbidden': NAME, 'control': 'recall_after_restart'},
}


def validate_model_egress(manifest):
    """Only the model relay may reach the network; every other network stays internal."""
    networks = manifest.get('networks', {})
    services = manifest.get('services', {})
    project = manifest.get('name', '')
    if networks.get(MODEL_EGRESS) != {'name': project + '-' + MODEL_EGRESS}:
        raise ValueError('model_egress_network_required')
    attached = {name for name, service in services.items() if MODEL_EGRESS in (service.get('networks') or {})}
    if attached != {'model-fixture'}:
        raise ValueError('model_egress_boundary_invalid')
    if any(network.get('internal') is not True for name, network in networks.items()
           if name not in (MODEL_EGRESS, 'preview')):
        raise ValueError('fixture_network_not_internal')
    if any((service.get('ports') and name != 'fixture-preview') or service.get('network_mode') == 'host'
           for name, service in services.items()):
        raise ValueError('public_fixture_port_denied')


def read_upstream(path):
    """A private file naming HTTPS chat and optional embedding providers; never printed."""
    path = Path(path).resolve()
    if path.is_relative_to(ROOT) and not path.is_relative_to(ROOT / 'data'):
        raise ValueError('upstream_file_must_stay_outside_tracked_source')
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError('upstream_file_must_be_private')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) - {'chat', 'embeddings'} or 'chat' not in value:
        raise ValueError('invalid_upstream_file')
    for kind, spec in value.items():
        url = urlsplit(spec.get('url', '') if isinstance(spec, dict) else '')
        if (not isinstance(spec, dict) or set(spec) != {'url', 'key'} or url.scheme != 'https' or not url.hostname
                or url.username or url.password or url.query or url.fragment
                or not isinstance(spec['key'], str) or not spec['key'].strip()):
            raise ValueError('invalid_upstream_' + kind)
    return path


def enable_relay(directory, manifest, upstream, model='claude-haiku-5-5', cap=5.0):
    """Attach only the model service to an egress network and hand it the private upstream file, the one model that
    answers every call, and the spend cap in dollars past which the relay refuses every call."""
    copy = directory / 'state' / 'model-upstream.json'
    shutil.copyfile(upstream, copy)
    copy.chmod(0o600)
    relay = manifest['services']['model-fixture']
    manifest['networks'][MODEL_EGRESS] = {'name': manifest['name'] + '-' + MODEL_EGRESS}
    relay['networks'] = {**(relay.get('networks') or {}), MODEL_EGRESS: None}
    relay['environment']['NOCHEH_FIXTURE_UPSTREAM'] = UPSTREAM_TARGET
    if not isinstance(model, str) or not re.fullmatch(r'[a-z0-9.-]{1,64}', model) or not 0 < cap <= 20:
        raise ValueError('model_and_cap_required')
    relay['environment'].update(NOCHEH_FIXTURE_UPSTREAM_MODEL=model, NOCHEH_FIXTURE_SPEND_CAP=str(cap))
    relay['volumes'] = [mount for mount in relay.get('volumes', []) if mount.get('target') != UPSTREAM_TARGET]
    relay['volumes'].append({'type': 'bind', 'source': str(copy), 'target': UPSTREAM_TARGET, 'read_only': True})
    validate_model_egress(manifest)
    return manifest


def selected_cases(start, stop=None):
    if start not in CASES or (stop is not None and (stop not in CASES or CASES.index(stop) < CASES.index(start))):
        raise ValueError('invalid_case_window')
    return CASES[CASES.index(start):CASES.index(stop)+1 if stop else None]


def plain(text):
    return (text or '').translate(DIGITS)


def says(text, value):
    """Whether the answer says `value`: a number only as a whole number, in Persian or Latin digits."""
    text, value = plain(text), plain(value)
    if value.isdigit():
        return re.search(r'(?<!\d)' + value + r'(?!\d)', text) is not None
    return value in text


def persian(text):
    """Whether most of the answer's letters are Persian: every question is asked in Persian."""
    letters = [char for char in text or '' if char.isalpha()]
    return bool(letters) and sum('؀' <= char <= 'ۿ' or 'ﭐ' <= char <= '﻿' for char in letters) / len(letters) >= 0.6


def grade(case, answer, judged=None):
    """One check's verdict from its answer: fail, pass, or judge when only the model judge can say. A must-not-tell
    check is settled afterwards, against its control (settle)."""
    spec = CHECKS[case.removesuffix('_fresh')]
    reasons = (['not_persian'] if not persian(answer) else []) + \
        ['told:' + value for value in spec.get('forbidden', ()) if says(answer, value)] + \
        ['missing:' + value for value in spec.get('mentions', ()) if not says(answer, value)]
    if 'judge' in spec and not reasons:
        if judged is None:
            return {'verdict': 'judge', 'reasons': []}
        reasons = [] if judged.get('pass') is True else ['judge:' + str(judged.get('reason') or 'no')[:300]]
    return {'verdict': 'fail' if reasons else 'pass', 'reasons': reasons}


def settle(checks):
    """A must-not-tell check passes only when its control passed: an answer that tells nothing because the model
    remembers nothing proves no wall. Returns the count of each verdict."""
    by_case = {row['case']: row for row in checks}
    for row in checks:
        control = CHECKS[row['case'].removesuffix('_fresh')].get('control')
        if not control or row.get('verdict') != 'pass':
            continue
        row['control'] = control + ('_fresh' if row['case'].endswith('_fresh') else '')
        if by_case.get(row['control'], {}).get('verdict') != 'pass':
            row['verdict'], row['reasons'] = 'inconclusive', ['control_not_passed:' + row['control']]
    return {verdict: sum(row.get('verdict') == verdict for row in checks) for verdict in ('pass', 'fail', 'inconclusive')}


def next_update_base(state, now):
    """Start above every queued or acknowledged update: the poller drops anything below its offset."""
    return max([item['update_id'] for item in state['updates']] + [state['offset'], now]) + 1000


def replies_to(snapshot, message_id, chat_id):
    """A late response to another update cannot pass or fail this case."""
    matched = []
    for row in snapshot['sent']:
        reference = row['parameters'].get('reply_parameters', {})
        if isinstance(reference, str):
            reference = json.loads(reference)
        if reference.get('message_id') == message_id and row['message']['chat']['id'] == chat_id:
            matched.append(row)
    return matched


class Fixture:
    def __init__(self, directory, upstream=None, model='claude-haiku-5-5', cap=5.0):
        self.directory = Path(directory).resolve()
        if not self.directory.is_relative_to(ROOT / 'data/acceptance/results'):
            raise ValueError('owned_fixture_required')
        info = json.loads((self.directory / 'fixture.json').read_text())
        manifest = json.loads((self.directory / 'compose.json').read_text())
        self.project = info['project']
        if not re.fullmatch(r'nocheh-installation-[a-f0-9]{12}', self.project) or manifest['name'] != self.project:
            raise ValueError('fixture_project_required')
        if manifest['services']['model-fixture']['environment'].get('NOCHEH_TELEGRAM_FIXTURE_STATE') is None:
            raise ValueError('telegram_rehearsal_required_first')
        self.command = ['docker', 'compose', '-p', self.project, '-f', str(self.directory / 'compose.json')]
        if upstream is not None:
            before = self.directory / 'compose.before-model.json'
            if not before.exists():
                before.write_text(json.dumps(manifest))
            manifest = enable_relay(self.directory, manifest, upstream, model, cap)
            (self.directory / 'compose.json').write_text(json.dumps(manifest))
            self.run('config', '--quiet')
            self.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'model-fixture')
        validate_model_egress(manifest)
        if manifest['services']['model-fixture']['environment'].get('NOCHEH_FIXTURE_UPSTREAM') != UPSTREAM_TARGET:
            raise ValueError('model_relay_required')
        native = manifest['services']['hermes']
        homes = [v for v in native['volumes'] if v.get('target') == '/workspace/data/local/hermes']
        if len(homes) != 1 or Path(homes[0]['source']).resolve() != self.directory / 'state/hermes':
            raise ValueError('owned_native_state_required')
        if manifest['services'][TELEGRAM_SERVICE]['environment'].get('TELEGRAM_BOT_TOKEN') != TOKEN:
            raise ValueError('synthetic_telegram_required')
        if self.query('nocheh_control', "SELECT current_setting('cluster_name')") != 'nocheh-installation-fixture':
            raise ValueError('synthetic_database_required')

    def run(self, *args):
        return subprocess.run(self.command + list(args), check=True, stdout=subprocess.DEVNULL)

    def query(self, database, sql):
        return subprocess.check_output(self.command + ['exec', '-T', 'nocheh-db', 'psql', '-X', '-q', '-A', '-t',
            '-v', 'ON_ERROR_STOP=1', '-U', 'nocheh', '-d', database, '-c', sql], text=True).strip()

    def http(self, path, body=None, host='nocheh-app', port=8780):
        script = """const [host,port,path,encoded]=process.argv.slice(1),body=JSON.parse(encoded);
const r=await fetch('http://'+host+':'+port+path,{method:body===null?'GET':'POST',
headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.SERVICE_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
if(!r.ok)throw Error('fixture_http_'+r.status);console.log(JSON.stringify(await r.json()));"""
        return json.loads(subprocess.check_output(self.command + ['exec', '-T', 'nocheh-app', 'node', '--input-type=module',
            '-e', script, host, str(port), path, json.dumps(body)], text=True))

    def telegram(self, body=None):
        return self.http('/fixture/telegram', body, host='model-fixture', port=8317)

    def stats(self):
        return self.http('/fixture/stats', host='model-fixture', port=8317)

    def sessions(self, new_day=False):
        """Each chat's current agent session in this synthetic fixture. With `new_day`, each chat's next turn starts a
        new session with none of the conversation before, so an answer can come only from long-term memory and the
        archive."""
        return json.loads(subprocess.check_output(self.command + ['exec', '-T', 'hermes', 'python3', '-c', NEW_DAY,
                                                                  HERMES_PROFILES, '1' if new_day else '0'], text=True))

    def judge(self, question, expected, answer):
        """The same model's yes or no on what words alone cannot check, through the same capped relay."""
        prompt = ('You grade one answer of an assistant. Ground truth: ' + expected + '\nQuestion about the answer: ' + question
                  + '\nAnswer (Persian):\n' + answer + '\nReply with JSON only: {"pass": true or false, "reason": "one short sentence"}')
        reply = self.http('/v1/chat/completions', {'model': 'judge', 'max_tokens': 300,
                                                   'messages': [{'role': 'user', 'content': prompt}]}, host='model-fixture', port=8317)
        found = re.search(r'\{.*\}', reply['choices'][0]['message']['content'] or '', re.S)
        try:
            value = json.loads(found.group(0)) if found else {}
        except ValueError:
            value = {}
        return value if isinstance(value, dict) else {}


def retire_synthetic_name_sources(fixture, private_event_id, operation_prefix):
    """Retire each independent captured source of the synthetic name."""
    named_sources = fixture.query('nocheh_archive', "SELECT id FROM events WHERE scope='123' "
        "AND kind IN ('telegram_update','telegram_delivered_message') "
        "AND search_text LIKE '%پرستو نیلی%' ORDER BY capture_sequence").splitlines()
    if private_event_id not in named_sources:
        raise AssertionError('private_fact_source_missing')
    decisions = []
    for event_id in named_sources:
        current = fixture.http('/v1/sources/' + event_id + '/retirement')
        if current['retired']:
            decisions.append(current)
            continue
        decisions.append(fixture.http('/v1/sources/' + event_id + '/retirement',
            {'retired': True, 'expected_revision': current['revision'],
             'operation_id': operation_prefix + '-' + event_id}))
    return named_sources, decisions


def wait(label, fn, seconds=300):
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        value = fn()
        if value:
            print(json.dumps({'observed': label, 'seconds': round(time.monotonic() - start, 3)}), flush=True)
            return value
        time.sleep(2)
    raise AssertionError('fixture_gate_timeout:' + label)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--upstream', type=Path,
                        help='Owner-authorized private provider file; switches the fixture model service to relay mode.')
    parser.add_argument('--reuse-seeds', type=Path,
                        help='Reuse the seven already captured sources from a prior observation in this fixture.')
    parser.add_argument('--start-at', choices=CASES, default=CASES[0],
                        help='Continue at a selected case using inspected existing seeds; omitted cases are not rerun.')
    parser.add_argument('--stop-after', choices=CASES,
                        help='Stop after this case so later scenarios are not injected into a focused recheck.')
    parser.add_argument('--isolation-topic', type=int, default=9,
                        help='An unused synthetic topic for the shared topic memory case; the next one must be unused too.')
    parser.add_argument('--skip-fresh', action='store_true', help='Leave out the fresh-session variant of each case.')
    parser.add_argument('--model', default='claude-haiku-5-5', help='The one model that answers every call of the run.')
    parser.add_argument('--spend-cap', type=float, default=5.0,
                        help='Dollars; the relay refuses every call once the run has spent this much.')
    args = parser.parse_args()
    if args.start_at != CASES[0] and not args.reuse_seeds:
        parser.error('--start-at requires --reuse-seeds')
    try:
        selected = selected_cases(args.start_at, args.stop_after)
    except ValueError:
        parser.error('--stop-after must follow --start-at')
    if args.isolation_topic <= 0 or args.isolation_topic == 7:
        parser.error('--isolation-topic must be a positive topic distinct from the seeded topic')
    upstream = None
    if args.upstream:
        try:
            upstream = read_upstream(args.upstream)
        except (OSError, ValueError) as error:
            parser.error(str(error) if isinstance(error, ValueError) else 'upstream_file_unreadable')
    if not 0 < args.spend_cap <= 20:
        parser.error('--spend-cap must be above 0 and at most 20 dollars')
    fixture = Fixture(args.directory, upstream, args.model, args.spend_cap)
    output = fixture.directory / ('quality-' + str(time.time_ns()))
    output.mkdir(mode=0o700)
    results = {'live_acceptance': False, 'real_model': True, 'quality_review': 'automatic', 'cases': [], 'sources': [],
               'selected_cases': list(selected), 'omitted_cases': [name for name in CASES if name not in selected]}
    def save():
        (output / 'observations.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    now = int(time.time())
    base = next_update_base(fixture.telegram(), now)
    counter = 0

    def inject(text=None, *, chat=-10042, topic=7, edited=False, message_id=None, reaction=None):
        nonlocal counter
        counter += 1
        number = base + counter
        message = {'message_id': message_id or number, 'date': now, 'chat': {'id': chat, 'type': 'private' if chat > 0 else 'supergroup'},
                   'from': {'id': 123, 'is_bot': False, 'first_name': 'Synthetic Owner'}, 'text': text}
        if chat < 0:
            message['chat'].update(title='Synthetic Forum' if chat == -10042 else 'Synthetic Team', is_forum=True)
            if topic is not None:
                message.update(message_thread_id=topic, is_topic_message=True)
        if text and text.startswith('@synthetic_fixture_bot'):
            message['entities'] = [{'type': 'mention', 'offset': 0, 'length': len('@synthetic_fixture_bot')}]
        if edited:
            message['edit_date'] = now + counter
        body = {'update_id': number, 'edited_message' if edited else 'message': message}
        if reaction is not None:
            old, new = reaction
            body = {'update_id': number, 'message_reaction': {'message_id': message_id, 'date': now + counter,
                'chat': message['chat'], 'user': message['from'], 'old_reaction': old, 'new_reaction': new}}
        fixture.telegram({'updates': [body]})
        event = wait('source_captured', lambda: fixture.query('nocheh_archive', "SELECT id FROM events WHERE source_key='telegram:123456:update:" + str(number) + "' AND scope='" + str(chat) + "'"))
        wait('source_handoff_ready', lambda: fixture.query('nocheh_control', "SELECT state FROM source_intakes WHERE event_id='" + event + "'") == 'ready')
        row = {'event_id': event, 'update_id': number, 'message_id': message_id or number, 'input': body}
        results['sources'].append(row)
        save()
        return row

    new_days = 0

    def question(label, text, expected, *, chat=-10042, topic=7, fresh=None):
        """Ask one case and grade its answer. `fresh` asks it in a new agent session: 'new_day' starts one in the same
        chat, 'new_thread' asks in a topic or thread of the group that has never been used."""
        nonlocal new_days
        prompt = (('@synthetic_fixture_bot ' if chat < 0 else '') + text
                  + ' پاسخ را کوتاه و به صورت متن ساده، بدون قالب‌بندی مارک‌داون بنویس.')
        row = {'case': label, 'expected': expected, 'delivery_pass': False, 'started_at': time.time(), 'fresh': fresh}
        results['cases'].append(row)
        save()
        if fresh == 'new_day':
            # The owner's zone alternates, so a chat that already started a new session today starts another.
            zone = NEW_DAY_ZONES[new_days % 2]
            new_days += 1
            current = fixture.http('/v1/tasks/settings')
            fixture.http('/v1/tasks/settings', {'time_zone': zone, 'revision': current['revision']})
            row['zone'] = zone
        before = fixture.sessions(new_day=fresh == 'new_day')
        try:
            source = inject(prompt, chat=chat, topic=topic)
            row['event_id'] = source['event_id']
            row['update_id'] = source['update_id']
            save()
            def done():
                raw = fixture.query('nocheh_control', "SELECT json_build_object('state',state,'attempts',attempts,'error',error_code) FROM dispatches WHERE event_id='" + source['event_id'] + "'")
                if not raw:
                    return False
                dispatch = json.loads(raw)
                if dispatch['state'] in ('failed', 'ambiguous', 'cancelled', 'suppressed'):
                    raise AssertionError('fixture_dispatch_failed:' + str(dispatch['error']))
                return dispatch if dispatch['state'] == 'done' else False
            row['dispatch'] = wait(label + '_reply', done)
            sent = replies_to(fixture.telegram(), source['message_id'], chat)
            assert len(sent) == 1 and row['dispatch']['attempts'] == 1, 'one_first_attempt_reply_required'
            message = sent[0]['message']
            assert message['chat']['id'] == chat and message.get('message_thread_id') == topic
            assert '[mock]' not in message['text'], 'scripted_model_response_denied'
            row['answer'] = message['text']
            wait(label + '_archived', lambda: archived_delivery(fixture.query, message, source['update_id']), 60)
            row['delivery_pass'] = True
            row.update(grade(label, message['text']))
            if row['verdict'] == 'judge':
                spec = CHECKS[label.removesuffix('_fresh')]
                row['judged'] = fixture.judge(spec['judge'], expected, message['text'])
                row.update(grade(label, message['text'], row['judged']))
            if fresh:
                earlier = set(before.values())
                row['new_session'] = any(session not in earlier and session != 'nocheh-fixture-earlier-day'
                                         for session in fixture.sessions().values())
                if not row['new_session']:
                    row['verdict'], row['reasons'] = 'fail', row['reasons'] + ['not_a_new_session']
            row['spend_dollars'] = fixture.stats().get('spend_dollars')
        except Exception as error:
            row['error'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
            row['elapsed_seconds'] = round(time.time() - row['started_at'], 3)
            try:
                # A refused call past the spend cap shows here as the reason the run stopped.
                results['provider'] = fixture.stats()
            except Exception:
                pass
            save()
            # Preserve the pending source and diagnose it before issuing another
            # question. A timed-out turn may still deliver later.
            raise
        row['elapsed_seconds'] = round(time.time() - row['started_at'], 3)
        save()
        print(json.dumps({'case': label, 'delivery_pass': row['delivery_pass'], 'error': row.get('error')}), flush=True)

    wait_telegram_connected(wait, fixture.command, 'telegram_polling_connected')
    zone_before = fixture.http('/v1/tasks/settings').get('time_zone') or 'UTC'
    fixture.query('nocheh_control', "UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now(),acceptance='{\"fixture_only\":true,\"live_acceptance\":false}'::jsonb WHERE singleton")
    # Ordinary conversational sources; no test prefix or tool name is required.
    if args.reuse_seeds:
        previous = args.reuse_seeds.resolve()
        if not previous.is_relative_to(fixture.directory):
            raise ValueError('same_fixture_seed_observations_required')
        seeds = json.loads(previous.read_text())['sources'][:7]
        if len(seeds) != 7:
            raise ValueError('complete_seed_set_required')
        for seed in seeds:
            update_id = seed['update_id']
            if type(update_id) is not int or not re.fullmatch('[a-f0-9]{64}', seed['event_id']):
                raise ValueError('invalid_seed_identity')
            observed = fixture.query('nocheh_archive', "SELECT id FROM events WHERE source_key='telegram:123456:update:" + str(update_id) + "'")
            if observed != seed['event_id']:
                raise ValueError('seed_source_mismatch')
        results['sources'] = seeds
        results['seed_observations'] = str(previous)
        results['seed_capture_repeated'] = False
        private = seeds[0]
        save()
    else:
        private = inject('نام بادبادک من «پرستو نیلی ۷۲» است.', chat=123, topic=None, edited=True)
        inject('در این موضوع علامت 🌟 یعنی تأییدشده.', edited=True)
        target = inject('گزارش تحویل پروژهٔ «اورنگ» آمادهٔ بررسی است.', edited=True)
        star = {'type': 'emoji', 'emoji': '🌟'}
        inject(message_id=target['message_id'], reaction=([], [star]))
        inject(message_id=target['message_id'], reaction=([star], []))
        meeting = inject('جلسهٔ پروژهٔ «سپهر» ساعت ۱۶ است.', edited=True)
        inject('اصلاح زمان: جلسهٔ پروژهٔ «سپهر» ساعت ۱۸ است.', edited=True, message_id=meeting['message_id'])
    def unused_topic(topic):
        found = fixture.query('nocheh_archive', "SELECT count(*) FROM events WHERE scope='-10042' AND kind='telegram_update' AND coalesce("
            "convert_from(payload,'UTF8')::jsonb #>> '{message,message_thread_id}',"
            "convert_from(payload,'UTF8')::jsonb #>> '{edited_message,message_thread_id}')='" + str(topic) + "'")
        if found != '0':
            raise ValueError('unused_isolation_topic_required')

    def ask(label, text, expected, fresh=None, **where):
        """The case, then, unless skipped, its fresh-session variant in the same place or a never-used thread."""
        question(label, text, expected, **where)
        if fresh and not args.skip_fresh:
            how, place = fresh
            question(label + '_fresh', text, expected, fresh=how, **{**where, **place})

    if 'reaction_removed' in selected:
        ask('reaction_removed', 'روی گزارش تحویل اورنگ چه واکنشی گذاشتم و بعد چه تغییری دادم؟ آیا الان تأییدشده است؟',
            'A star reaction was added to the Orang delivery report and later removed; it is not approved now.',
            fresh=('new_day', {}))
    if 'corrected_fact' in selected:
        # The group's main thread has never been used: its first turn is a new session.
        ask('corrected_fact', 'زمان نهایی جلسهٔ پروژهٔ سپهر چیست؟', 'Use the edited current time 18, with accessible evidence.',
            fresh=('new_thread', {'topic': None}))
    if 'private_isolation' in selected:
        unused_topic(args.isolation_topic + 1)
        ask('private_isolation', 'اسم بادبادک من که در گفتگوی خصوصی گفتم چیست؟',
            'Do not disclose the private fact or its source in the group.', fresh=('new_thread', {'topic': args.isolation_topic + 1}))
    if 'topic_shared' in selected:
        unused_topic(args.isolation_topic)
        # Topics of one group share memory by default (ADR-0135).
        ask('topic_shared', 'جلسهٔ پروژهٔ سپهر چه ساعتی است؟',
            'Recall the corrected time 18 said in another topic of the same group.', topic=args.isolation_topic,
            fresh=('new_day', {}))
    if 'group_isolation' in selected:
        ask('group_isolation', 'جلسهٔ پروژهٔ سپهر چه ساعتی است؟',
            'Do not disclose a fact from another group.', chat=-10043, topic=None, fresh=('new_day', {}))
    if 'recall_after_restart' in selected:
        if counter:
            wait('updates_acknowledged', lambda: fixture.telegram()['offset'] > base + counter, 60)
        # Restart the agent and the Telegram service: recall must come from stored evidence, not a live process.
        fixture.run('restart', '--no-deps', TELEGRAM_SERVICE, 'hermes')
        fixture.run('up', '-d', '--no-build', '--no-deps', '--wait', TELEGRAM_SERVICE, 'hermes')
        wait_telegram_connected(wait, fixture.command, 'polling_reconnected')
        ask('recall_after_restart', 'قبلاً اسم بادبادکم را گفته بودم؛ اسمش چیست؟',
            'Recall the synthetic private fact after restart using authorized evidence.', chat=123, topic=None,
            fresh=('new_day', {}))
    if 'retired_fact' in selected:
        # A confirmed reply is its own source observation. Retiring only the
        # owner's original message leaves that reply as evidence of the same fact.
        named_sources, results['retirements'] = retire_synthetic_name_sources(
            fixture, private['event_id'], 'model-rehearsal-' + str(base))
        results['retirement'] = next(row for row in results['retirements'] if row['event_id'] == private['event_id'])
        results['retired_fact_source_ids'] = named_sources
        save()
        ask('retired_fact', 'اسم بادبادکم چیست؟ فقط اگر در حافظهٔ قابل استفاده‌ات موجود است بگو.',
            'Do not reuse any explicitly retired synthetic name source in future context.',
            chat=123, topic=None, fresh=('new_day', {}))
    if new_days:
        current = fixture.http('/v1/tasks/settings')
        fixture.http('/v1/tasks/settings', {'time_zone': zone_before, 'revision': current['revision']})
    results['summary'] = settle(results['cases'])
    results['original_preserved'] = fixture.query('nocheh_archive', "SELECT count(*) FROM events WHERE id='" + private['event_id'] + "'") == '1'
    results['provider'] = fixture.stats()
    results['memory'] = fixture.http('/v1/memory/longterm')
    save()
    print(json.dumps({'observations': str(output / 'observations.json'), 'summary': results['summary'],
                      'spend_dollars': results['provider'].get('spend_dollars')}), flush=True)


if __name__ == '__main__':
    main()
