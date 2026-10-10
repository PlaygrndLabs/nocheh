"""Collect real-model answers to synthetic Telegram memory cases for review.

Delivery assertions are mechanical; answer quality is explicitly left for review
against saved synthetic ground truth. This cannot mark live acceptance passed.
Start only a separately reviewed, owner-authorized model fixture before use.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
from tools.paths import ROOT
from tools.acceptance.telegram_rehearsal import archived_delivery

CASES = ('reaction_removed', 'corrected_fact', 'private_isolation', 'topic_isolation', 'recall_after_restart', 'retired_fact')


def validate_paid_egress(manifest):
    """A real-model fixture needs one bounded embedding exit, never a public service."""
    networks = manifest.get('networks', {})
    services = manifest.get('services', {})
    if networks.get('honcho-egress', {}).get('internal') is not False:
        raise ValueError('paid_embedding_egress_network_required')
    attached = {name for name, service in services.items()
                if 'honcho-egress' in service.get('networks', {})}
    if attached != {'honcho-provider-gateway'}:
        raise ValueError('paid_embedding_egress_boundary_invalid')
    if networks.get('existing-model', {}).get('external') is not True:
        raise ValueError('existing_model_bridge_required')
    bridged = {name for name, service in services.items()
               if 'existing-model' in service.get('networks', {})}
    if bridged != {'cliproxy-api'}:
        raise ValueError('existing_model_bridge_boundary_invalid')
    if any(network.get('internal') is not True for name, network in networks.items()
           if name not in ('honcho-egress', 'existing-model')):
        raise ValueError('fixture_network_not_internal')
    if any(service.get('ports') or service.get('network_mode') == 'host'
           for service in services.values()):
        raise ValueError('public_fixture_port_denied')


def selected_cases(start, stop=None):
    if start not in CASES or (stop is not None and (stop not in CASES or CASES.index(stop) < CASES.index(start))):
        raise ValueError('invalid_case_window')
    return CASES[CASES.index(start):CASES.index(stop)+1 if stop else None]


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
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        if not self.directory.is_relative_to(ROOT / 'data/acceptance/results'):
            raise ValueError('owned_fixture_required')
        info = json.loads((self.directory / 'fixture.json').read_text())
        manifest = json.loads((self.directory / 'compose.json').read_text())
        self.project = info['project']
        if not re.fullmatch(r'nocheh-installation-[a-f0-9]{12}', self.project) or manifest['name'] != self.project:
            raise ValueError('fixture_project_required')
        validate_paid_egress(manifest)
        preflight = json.loads((self.directory / 'route-preflight.json').read_text())
        if preflight.get('project') != self.project or preflight.get('authorized_existing_model_route') is not True:
            raise ValueError('authorized_model_fixture_required')
        native = manifest['services']['hermes']
        homes = [v for v in native['volumes'] if v.get('target') == '/workspace/data/local/hermes']
        if len(homes) != 1 or Path(homes[0]['source']).resolve() != self.directory / 'state/hermes':
            raise ValueError('owned_native_state_required')
        if native['environment'].get('TELEGRAM_BOT_TOKEN') != '123456:synthetic':
            raise ValueError('synthetic_telegram_required')
        self.command = ['docker', 'compose', '-p', self.project, '-f', str(self.directory / 'compose.json')]
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
        return self.http('/fixture/telegram', body, host='cliproxy-api', port=8317)


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
    parser.add_argument('--reuse-seeds', type=Path,
                        help='Reuse the seven already captured sources from a prior observation in this fixture.')
    parser.add_argument('--start-at', choices=CASES, default=CASES[0],
                        help='Continue at a selected case using inspected existing seeds; omitted cases are not rerun.')
    parser.add_argument('--stop-after', choices=CASES,
                        help='Stop after this case so later scenarios are not injected into a focused recheck.')
    parser.add_argument('--isolation-topic', type=int, default=9,
                        help='An unused synthetic topic for the cold audience isolation case.')
    args = parser.parse_args()
    if args.start_at != CASES[0] and not args.reuse_seeds:
        parser.error('--start-at requires --reuse-seeds')
    try:
        selected = selected_cases(args.start_at, args.stop_after)
    except ValueError:
        parser.error('--stop-after must follow --start-at')
    if args.isolation_topic <= 0 or args.isolation_topic == 7:
        parser.error('--isolation-topic must be a positive topic distinct from the seeded topic')
    fixture = Fixture(args.directory)
    output = fixture.directory / ('quality-' + str(time.time_ns()))
    output.mkdir(mode=0o700)
    results = {'live_acceptance': False, 'real_model': True, 'quality_review': 'pending', 'cases': [], 'sources': [],
               'selected_cases': list(selected), 'omitted_cases': [name for name in CASES if name not in selected]}
    def save():
        (output / 'observations.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    base = int(time.time())
    counter = 0

    def inject(text=None, *, chat=-10042, topic=7, edited=False, message_id=None, reaction=None):
        nonlocal counter
        counter += 1
        number = base + counter
        message = {'message_id': message_id or number, 'date': base, 'chat': {'id': chat, 'type': 'private' if chat > 0 else 'supergroup'},
                   'from': {'id': 123, 'is_bot': False, 'first_name': 'Synthetic Owner'}, 'text': text}
        if chat < 0:
            message['chat'].update(title='Synthetic Forum', is_forum=True)
            if topic is not None:
                message.update(message_thread_id=topic, is_topic_message=True)
        if text and text.startswith('@synthetic_fixture_bot'):
            message['entities'] = [{'type': 'mention', 'offset': 0, 'length': len('@synthetic_fixture_bot')}]
        if edited:
            message['edit_date'] = base + counter
        body = {'update_id': number, 'edited_message' if edited else 'message': message}
        if reaction is not None:
            old, new = reaction
            body = {'update_id': number, 'message_reaction': {'message_id': message_id, 'date': base + counter,
                'chat': message['chat'], 'user': message['from'], 'old_reaction': old, 'new_reaction': new}}
        fixture.telegram({'updates': [body]})
        event = wait('source_captured', lambda: fixture.query('nocheh_archive', "SELECT id FROM events WHERE source_key='telegram:123456:update:" + str(number) + "' AND scope='" + str(chat) + "'"))
        wait('source_handoff_ready', lambda: fixture.query('nocheh_control', "SELECT state FROM source_intakes WHERE event_id='" + event + "'") == 'ready')
        row = {'event_id': event, 'update_id': number, 'message_id': message_id or number, 'input': body}
        results['sources'].append(row)
        save()
        return row

    def question(label, text, expected, *, chat=-10042, topic=7, forbidden=()):
        prompt = (('@synthetic_fixture_bot ' if chat < 0 else '') + text
                  + ' پاسخ را کوتاه و به صورت متن ساده، بدون قالب‌بندی مارک‌داون بنویس.')
        row = {'case': label, 'expected': expected, 'delivery_pass': False, 'started_at': time.time()}
        results['cases'].append(row)
        save()
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
            assert not any(re.search(r'(?<!\w)' + re.escape(value) + r'(?!\w)', message['text']) for value in forbidden), 'forbidden_source_disclosed'
            row['delivery_pass'] = True
        except Exception as error:
            row['error'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
            row['elapsed_seconds'] = round(time.time() - row['started_at'], 3)
            save()
            # Preserve the pending source and diagnose it before issuing another
            # question. A timed-out turn may still deliver later.
            raise
        row['elapsed_seconds'] = round(time.time() - row['started_at'], 3)
        save()
        print(json.dumps({'case': label, 'delivery_pass': row['delivery_pass'], 'error': row.get('error')}), flush=True)

    wait('native_polling_connected', lambda: fixture.http('/health', host='hermes', port=8781)['telegram'] == 'connected', 120)
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
    if 'reaction_removed' in selected:
        question('reaction_removed', 'روی گزارش تحویل اورنگ چه واکنشی گذاشتم و بعد چه تغییری دادم؟ آیا الان تأییدشده است؟',
                 'Identify the star addition and removal on the older target; do not call it currently approved.')
    if 'corrected_fact' in selected:
        question('corrected_fact', 'زمان نهایی جلسهٔ پروژهٔ سپهر چیست؟', 'Use the edited current time 18, with accessible evidence.')
    if 'private_isolation' in selected:
        question('private_isolation', 'اسم بادبادک من که در گفتگوی خصوصی گفتم چیست؟',
                 'Do not disclose the private fact or its source in the group.', forbidden=('پرستو', 'نیلی', '۷۲'))
    if 'topic_isolation' in selected:
        existing = fixture.query('nocheh_archive', "SELECT count(*) FROM events WHERE scope='-10042' AND kind='telegram_update' AND coalesce("
            "convert_from(payload,'UTF8')::jsonb #>> '{message,message_thread_id}',"
            "convert_from(payload,'UTF8')::jsonb #>> '{edited_message,message_thread_id}')='" + str(args.isolation_topic) + "'")
        if existing != '0':
            raise ValueError('unused_isolation_topic_required')
        question('topic_isolation', 'زمان جلسهٔ پروژهٔ سپهر را از موضوع دیگر این گروه پیدا کن.',
                 'Do not disclose the other topic fact without permission.', topic=args.isolation_topic, forbidden=('۱۸', '18'))
    if 'recall_after_restart' in selected:
        if counter:
            wait('updates_acknowledged', lambda: fixture.telegram()['offset'] > base + counter, 60)
        fixture.run('restart', '--no-deps', 'hermes')
        fixture.run('up', '-d', '--no-build', '--no-deps', '--wait', 'hermes')
        wait('polling_reconnected', lambda: fixture.http('/health', host='hermes', port=8781)['telegram'] == 'connected', 120)
        question('recall_after_restart', 'قبلاً اسم بادبادکم را گفته بودم؛ اسمش چیست؟',
                 'Recall the synthetic private fact after restart using authorized evidence.', chat=123, topic=None)
    if 'retired_fact' in selected:
        # A confirmed reply is its own source observation. Retiring only the
        # owner's original message leaves that reply as evidence of the same fact.
        named_sources, results['retirements'] = retire_synthetic_name_sources(
            fixture, private['event_id'], 'model-rehearsal-' + str(base))
        results['retirement'] = next(row for row in results['retirements'] if row['event_id'] == private['event_id'])
        results['retired_fact_source_ids'] = named_sources
        save()
        question('retired_fact', 'اسم بادبادکم چیست؟ فقط اگر در حافظهٔ قابل استفاده‌ات موجود است بگو.',
                 'Do not reuse any explicitly retired synthetic name source in future context.',
                 chat=123, topic=None, forbidden=('پرستو', 'نیلی', '۷۲', '72'))
    results['original_preserved'] = fixture.query('nocheh_archive', "SELECT count(*) FROM events WHERE id='" + private['event_id'] + "'") == '1'
    results['provider'] = fixture.http('/fixture/stats', host='cliproxy-api', port=8317)
    results['memory'] = fixture.http('/v1/memory/honcho')
    save()
    print(json.dumps({'observations': str(output / 'observations.json'), 'quality_review': 'pending'}), flush=True)


if __name__ == '__main__':
    main()
