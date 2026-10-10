"""Personal-use Telegram scenarios on an owned HTTP Bot API fixture.

Extends tools.acceptance.telegram_rehearsal on the same synthetic installation:
actual Hermes polling, three stores, workflows, Honcho and the scripted fixture
brain. Directives such as ``[[search:...]]`` make the fixture model request
real Nocheh tools; they test plumbing, isolation and effects, not judgement.
Each scenario is recorded separately and later scenarios still run after a
failure. Nothing here establishes live Telegram or model acceptance.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback
from tools.paths import ROOT
from tools.acceptance.telegram_rehearsal import archived_delivery, validate_fixture

OWNER, GROUP, OTHER_GROUP, UNSELECTED_GROUP, PARTICIPANT = 123, -10042, -10043, -10099, 777
MENTION = '@synthetic_fixture_bot'
CANARY = 'fixture-secret-ORCHID-2718'
PRIVATE_FACT = 'رنگ مورد علاقه‌ی خواهرم فیروزه‌ای است PRIVFACT91'


class Failed(AssertionError):
    pass


class Fixture:
    def __init__(self, directory):
        self.directory = directory
        info = json.loads((directory/'fixture.json').read_text())
        self.manifest = json.loads((directory/'compose.json').read_text())
        self.project = validate_fixture(directory, info, self.manifest)
        self.command = ['docker', 'compose', '-p', self.project, '-f', str(directory/'compose.json')]
        self.next_id = None

    def run(self, *args, **kwargs):
        return subprocess.run(self.command+list(args), check=True, **kwargs)

    def query(self, database, sql):
        return subprocess.check_output(self.command+['exec', '-T', 'nocheh-db', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-U', 'nocheh', '-d', database, '-c', sql], text=True).strip()

    def http(self, path, body=None, service='cliproxy-api', port=8317, allow_error=False):
        script = """const [service,port,path,encoded,tolerant]=process.argv.slice(1),body=JSON.parse(encoded);
const response=await fetch('http://'+service+':'+port+path,{method:body===null?'GET':'POST',
headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.SERVICE_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
const text=await response.text();
if(!response.ok&&tolerant!=='1')throw Error('fixture_http_'+response.status+':'+text.slice(0,300));
console.log(JSON.stringify({status:response.status,body:text?JSON.parse(text):null}));"""
        result = json.loads(subprocess.check_output(self.command+['exec', '-T', 'nocheh-app', 'node', '--input-type=module', '-e', script,
            service, str(port), path, json.dumps(body), '1' if allow_error else '0'], text=True))
        return result if allow_error else result['body']

    def app(self, path, body=None, allow_error=False):
        return self.http(path, body, service='nocheh-app', port=8780, allow_error=allow_error)

    def native(self, path, body=None, method=None):
        """The owner's native administration route, as `./bin/nocheh cron` calls it."""
        script = """const [path,encoded,method]=process.argv.slice(1),body=JSON.parse(encoded);
const response=await fetch('http://hermes:8785'+path,{method:method||(body===null?'GET':'POST'),
headers:{'content-type':'application/json','X-Hermes-Session-Token':process.env.SERVICE_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
const text=await response.text();if(!response.ok)throw Error('native_http_'+response.status+':'+text.slice(0,300));console.log(text);"""
        return json.loads(subprocess.check_output(self.command+['exec', '-T', 'nocheh-app', 'node', '--input-type=module', '-e', script,
            path, json.dumps(body), method or ''], text=True))

    def telegram(self):
        return self.http('/fixture/telegram')

    def ids(self):
        if self.next_id is None:
            state = self.telegram()
            known = [item['update_id'] for item in state['updates']]+[state['offset'], int(time.time())]
            self.next_id = max(known)+1000
        self.next_id += 1
        return self.next_id

    def message(self, chat, text=None, sender=OWNER, topic=None, mention=None, reply_to=None, extra=None):
        number = self.ids()
        group = chat < 0
        mention = group if mention is None else mention
        message = {'message_id': number, 'date': int(time.time()),
            'chat': {'id': chat, 'type': 'supergroup' if group else 'private'},
            'from': {'id': sender, 'is_bot': False, 'first_name': 'Synthetic '+str(sender)}}
        if group:
            message['chat'].update(title='Synthetic Forum '+str(chat), is_forum=True)
        if text is not None:
            if mention:
                text = MENTION+' '+text
                message['entities'] = [{'type': 'mention', 'offset': 0, 'length': len(MENTION)}]
            message['text'] = text
        if topic is not None:
            message.update(message_thread_id=topic, is_topic_message=True)
        if reply_to is not None:
            message['reply_to_message'] = reply_to
        message.update(extra or {})
        return {'update_id': number, 'message': message}

    def inject(self, *updates):
        self.http('/fixture/telegram', {'updates': list(updates)})

    def event(self, update_id):
        return self.query('nocheh_archive', "SELECT id FROM events WHERE kind='telegram_update' AND "
            "(convert_from(payload,'UTF8')::jsonb->>'update_id')='"+str(int(update_id))+"'")

    def dispatch(self, event_id):
        raw = self.query('nocheh_control', "SELECT json_build_object('state',state,'attempts',attempts,'error',error_code,"
            "'stage',runtime_stage) FROM dispatches WHERE event_id='"+event_id+"'")
        return json.loads(raw) if raw else None

    def sent(self):
        return self.telegram()['sent']

    def brain(self):
        return self.http('/fixture/brain')['events']

    def control(self, body):
        return self.http('/fixture/telegram/control', body)


class Scenarios:
    def __init__(self, fixture, report):
        self.f, self.report, self.results, self.current = fixture, report, [], None
        # Every (scenario, event) whose single causal reply was verified; the
        # stage timing scenario reads one breakdown for each of them.
        self.replied = []
        self.real_model = False

    def save(self):
        (self.report/'progress.json').write_text(json.dumps(self.results, indent=2, ensure_ascii=False)+'\n')

    def gate(self, label, value=True, **observed):
        if not value:
            self.current['failed_gate'] = {'gate': label, **observed}
            raise Failed(label)
        self.current['gates'].append({'gate': label, **observed})
        print(json.dumps({'scenario': self.current['scenario'], 'gate': label, **observed}, ensure_ascii=False), flush=True)

    def wait(self, label, check, seconds=240, interval=2):
        started = time.monotonic()
        while time.monotonic()-started < seconds:
            value = check()
            if value:
                self.gate(label, seconds=round(time.monotonic()-started, 3))
                return value
            time.sleep(interval)
        raise Failed('timeout:'+label)

    def captured(self, update):
        return self.wait('captured', lambda: self.f.event(update['update_id']), 60)

    def finished(self, event_id, label='dispatch_closed', seconds=300):
        def check():
            row = self.f.dispatch(event_id)
            return row if row and row['state'] in ('done', 'failed', 'ambiguous', 'suppressed', 'cancelled') and \
                not (row['state'] == 'failed' and row['error'] in (None, 'model_unavailable', 'assistant_runtime_unavailable')) else False
        return self.wait(label, check, seconds)

    def replies(self, before, chat, topic=None):
        return [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == chat
                and row['message'].get('message_thread_id') == topic]

    def turn(self, update, chat, topic=None, expect_reply=True, attempts=1):
        """Inject one update and verify its single causal reply or its silence."""
        before = len(self.f.sent())
        self.f.inject(update)
        event_id = self.captured(update)
        row = self.finished(event_id)
        if not expect_reply:
            self.gate('no_reply_dispatch', row['state'] in ('suppressed', 'cancelled'), state=row['state'], error=row['error'])
            time.sleep(3)
            self.gate('no_physical_reply', not self.replies(before, chat, topic))
            return event_id, None
        self.gate('dispatch_done', row['state'] == 'done', state=row['state'], error=row['error'], attempts=row['attempts'])
        if attempts is not None:
            self.gate('dispatch_attempts', row['attempts'] == attempts, attempts=row['attempts'])
        new = self.replies(before, chat, topic)
        self.gate('one_reply_in_exact_conversation', len(new) == 1, count=len(new))
        reply = json.loads(new[0]['parameters'].get('reply_parameters', '{}') or '{}')
        self.gate('reply_targets_source', reply.get('message_id') == update['message']['message_id'])
        self.wait('delivery_archived', lambda: archived_delivery(self.f.query, new[0]['message'], update['update_id']), 60)
        self.replied.append((self.current['scenario'], event_id))
        if self.real_model:  # Real answers are saved for review against the scenario's intent.
            self.current.setdefault('answers', []).append({'asked': update['message'].get('text') or update['message'].get('caption'),
                                                           'answered': new[0]['message']['text'][:4000]})
        return event_id, new[0]['message']['text']

    def execute(self, name, function):
        self.current = {'scenario': name, 'gates': [], 'passed': False, 'started': time.time()}
        self.results.append(self.current)
        try:
            function()
            self.current['passed'] = True
        except Exception as error:
            self.current['error'] = str(error) if isinstance(error, AssertionError) else type(error).__name__+':'+str(error)[:500]
            self.current['trace'] = traceback.format_exc()[-2000:]
            print(json.dumps({'scenario': name, 'failed': self.current['error']}, ensure_ascii=False), flush=True)
        self.current['seconds'] = round(time.time()-self.current.pop('started'), 3)
        self.save()

    # Conversation basics ---------------------------------------------------

    def reply_during_polling_reconnect(self):
        # Recreating the fixture endpoint also loads current fixture code. The
        # native adapter then reconnects polling; a reply ready in that window
        # was never transmitted and must be retried, then delivered once.
        started = time.time()
        self.f.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'cliproxy-api')
        self.wait('polling_connected', lambda: self.f.http('/health', service='hermes', port=8781)['telegram'] == 'connected', 120)
        update = self.f.message(OWNER, 'سلام، هنوز وصلی؟')
        _, _ = self.turn(update, OWNER, attempts=None)
        row = self.f.dispatch(self.f.event(update['update_id']))
        self.gate('delivered_within_two_attempts', row['attempts'] <= 2, attempts=row['attempts'])
        self.wait('polling_reconnect_settled', lambda: any(call['method'] == 'getMe' and call['at'] > started
                                                          for call in self.f.telegram()['calls']), 120)
        time.sleep(5)

    def ordinary_private(self):
        update = self.f.message(OWNER, 'سلام نوچه، امروز چطوری؟ 🌱')
        self.state = {'first_private': update}
        self.turn(update, OWNER)

    def edit_is_silent(self):
        original = self.state['first_private']['message']
        before = len(self.f.sent())
        number = self.f.ids()
        edited = {**original, 'text': 'سلام نوچه، امروز چطوری؟ (ویرایش‌شده)', 'edit_date': int(time.time())}
        self.f.inject({'update_id': number, 'edited_message': edited})
        event_id = self.captured({'update_id': number})
        self.gate('edit_is_new_revision', self.f.query('nocheh_archive', "SELECT count(*) FROM events WHERE kind='telegram_update' AND scope='"
            +str(OWNER)+"' AND source_id='"+str(original['message_id'])+"'") == '2')
        time.sleep(20)
        row = self.f.dispatch(event_id)
        self.gate('edit_not_dispatched_as_reply', row is None or row['state'] == 'suppressed' and row['attempts'] == 0, row=row)
        self.gate('edit_sends_nothing', not self.replies(before, OWNER))

    def reaction_is_silent(self):
        original = self.state['first_private']['message']
        before = len(self.f.sent())
        number = self.f.ids()
        self.f.inject({'update_id': number, 'message_reaction': {'chat': {'id': OWNER, 'type': 'private'}, 'message_id': original['message_id'],
            'user': {'id': OWNER, 'is_bot': False, 'first_name': 'Synthetic 123'}, 'date': int(time.time()),
            'old_reaction': [], 'new_reaction': [{'type': 'emoji', 'emoji': '👍'}]}})
        event_id = self.captured({'update_id': number})
        time.sleep(20)
        row = self.f.dispatch(event_id)
        self.gate('reaction_not_dispatched_as_reply', row is None or row['state'] == 'suppressed' and row['attempts'] == 0, row=row)
        self.gate('reaction_sends_nothing', not self.replies(before, OWNER))

    def burst_in_order(self, chat=GROUP, topic=15):
        before = len(self.f.sent())
        updates = [self.f.message(chat, 'پیام سریع شماره '+str(index), topic=topic) for index in range(1, 4)]
        self.f.inject(*updates)
        events = [self.captured(update) for update in updates]
        for event_id in events:
            row = self.finished(event_id)
            self.gate('burst_dispatch_done', row['state'] == 'done', state=row['state'], error=row['error'])
        new = self.replies(before, chat, topic)
        self.gate('one_reply_per_message', len(new) == 3, count=len(new))
        targets = [json.loads(row['parameters'].get('reply_parameters', '{}')).get('message_id') for row in new]
        self.gate('replies_in_telegram_order', targets == [update['message']['message_id'] for update in updates], targets=targets)

    def private_burst_in_order(self):
        self.burst_in_order(OWNER, None)

    def long_reply_chunks(self):
        topic = 14
        before = len(self.f.sent())
        update = self.f.message(GROUP, 'یک پاسخ طولانی بده [[long:9000]]', topic=topic)
        self.f.inject(update)
        row = self.finished(self.captured(update))
        self.gate('dispatch_done', row['state'] == 'done', state=row['state'], error=row['error'])
        new = self.replies(before, GROUP, topic)
        other = [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == GROUP and row['message'].get('message_thread_id') != topic]
        self.gate('chunked_into_several_messages', len(new) >= 3, count=len(new))
        self.gate('every_chunk_in_exact_topic', not other, stray=len(other))
        self.gate('chunks_within_limit', all(len(row['message']['text']) <= 4096 for row in new))
        text = ' '.join(row['message']['text'] for row in new)
        self.gate('complete_text_delivered', 'بخش1 ' in text and ('بخش'+str(self.last_words()) in text), length=len(text))
        for row in new:
            self.wait('chunk_archived', lambda row=row: archived_delivery(self.f.query, row['message'], update['update_id']), 60)

    def last_words(self):
        events = [event for event in self.f.brain() if event.get('directive') == 'long']
        return events[-1]['words']

    def intentional_silence(self):
        update = self.f.message(GROUP, 'اینجا لازم نیست جواب بدی [[silent]]', topic=12)
        _, _ = self.turn(update, GROUP, 12, expect_reply=False)
        row = self.f.dispatch(self.f.event(update['update_id']))
        self.gate('recorded_as_intentional_silence', row['error'] == 'intentional_silence', row=row)

    def empty_answer_is_not_silence(self):
        update = self.f.message(GROUP, 'جواب بده [[empty-once:E1]]', topic=13)
        _, text = self.turn(update, GROUP, 13, attempts=None)
        row = self.f.dispatch(self.f.event(update['update_id']))
        phases = [event['phase'] for event in self.f.brain() if event.get('directive') == 'empty-once' and event.get('argument') == 'E1']
        self.gate('blank_answer_was_retried', phases[:2] == ['empty', 'final'], phases=phases, attempts=row['attempts'])
        self.gate('blank_answer_not_recorded_as_silence', row['state'] == 'done' and row['error'] is None)
        self.gate('recovered_answer_delivered', '[brain] recovered E1' in text)

    # Memory, tools and audience ---------------------------------------------

    def private_fact_and_search(self):
        fact = self.f.message(OWNER, 'یادت باشه: '+PRIVATE_FACT)
        self.state['fact'] = fact
        self.state['fact_event'], _ = self.turn(fact, OWNER)
        _, text = self.turn(self.f.message(OWNER, 'دنبالش بگرد [[search:PRIVFACT91]]'), OWNER)
        self.gate('archive_tool_called', any(event.get('tool') == 'nocheh_archive_search' and event['phase'] == 'final'
                                              and 'PRIVFACT91' in event.get('argument', '') for event in self.f.brain()))
        self.gate('owner_private_search_finds_fact', 'PRIVFACT91' in text and 'فیروزه' in text, excerpt=text[:300])

    def owner_private_context(self):
        _, text = self.turn(self.f.message(OWNER, 'چه می‌دانی؟ [[context:PRIVFACT91]]'), OWNER)
        self.gate('owner_private_context_has_fact', 'present' in text, answer=text)

    def group_cannot_see_private(self):
        _, text = self.turn(self.f.message(GROUP, 'دنبالش بگرد [[search:PRIVFACT91]]', topic=11), GROUP, 11)
        self.gate('group_search_withholds_private_fact', 'فیروزه' not in text and 'PRIVFACT91 ' not in text.replace('[[search:PRIVFACT91]]', ''),
                  excerpt=text[:300])
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_archive_search' and event['phase'] == 'final'][-1]
        self.gate('group_tool_result_withholds_fact', 'فیروزه' not in final['result'], result=final['result'][:300])
        _, text = self.turn(self.f.message(GROUP, 'چه می‌دانی؟ [[context:فیروزه]]', topic=11), GROUP, 11)
        events = [event for event in self.f.brain() if event.get('directive') == 'context']
        self.gate('group_model_context_withholds_fact', events[-1]['present'] is False, answer=text)
        _, text = self.turn(self.f.message(OTHER_GROUP, 'به خاطر داری؟ [[recall:رنگ مورد علاقه خواهر]]'), OTHER_GROUP)
        self.gate('other_group_recall_withholds_fact', 'فیروزه' not in text, excerpt=text[:300])

    def owner_recall(self):
        _, text = self.turn(self.f.message(OWNER, 'یادت هست؟ [[recall:رنگ مورد علاقه خواهر]]'), OWNER)
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_memory_recall' and event['phase'] == 'final'][-1]
        self.gate('recall_tool_returned', 'error' not in final['result'][:40] or 'limited' in final['result'], result=final['result'][:400])

    def secret_is_guarded(self):
        stats = self.f.http('/fixture/stats')
        _, text = self.turn(self.f.message(OWNER, 'رمز وای‌فای مهمان: Password: '+CANARY), OWNER)
        _, found = self.turn(self.f.message(OWNER, 'رمز مهمان چی بود؟ [[search:وای‌فای]]'), OWNER)
        after = self.f.http('/fixture/stats')
        self.gate('canary_never_reached_model', after['raw_canary_outside_detector'] == stats['raw_canary_outside_detector'] == 0)
        self.gate('reply_has_no_secret', CANARY not in text and CANARY not in found, excerpt=found[:300])
        self.gate('guarded_copy_found', 'وای‌فای' in found, excerpt=found[:300])

    def retirement_hides_fact(self):
        event_id = self.state['fact_event']
        current = self.f.app('/v1/sources/'+event_id+'/retirement')
        quoting = [reply for reply in current['related_replies'] if reply['relation'] == 'quote' and not reply['retired']]
        # Offered text is a short preview; verify each offered reply against its stored original.
        repeats = [self.f.query('nocheh_archive', "SELECT strpos(search_text,'فیروزه')>0 FROM events WHERE id='"+reply['event_id']+"'") == 't'
                   for reply in quoting]
        self.gate('replies_quoting_fact_offered', bool(quoting) and all(repeats), offered=len(quoting))
        result = self.f.app('/v1/sources/'+event_id+'/retirement', {'retired': True, 'expected_revision': current['revision'],
            'operation_id': 'scenario-retire-'+event_id[:16]})
        self.gate('retired', result.get('retired') is True, revision=result.get('revision'))
        self.wait('retirement_visible', lambda: self.f.app('/v1/sources/'+event_id+'/retirement')['retired'] is True, 60)
        _, text = self.turn(self.f.message(OWNER, 'دوباره بگرد [[search:PRIVFACT91]]'), OWNER)
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_archive_search' and event['phase'] == 'final'][-1]
        sources = json.loads(final['result'])['sources']
        self.gate('retired_source_not_retrieved', all(row['id'] != event_id for row in sources),
                  returned=[row['kind'] for row in sources])
        self.gate('offered_replies_not_retired_implicitly', all(not reply['retired'] for reply in
                  self.f.app('/v1/sources/'+event_id+'/retirement')['related_replies'] if reply['relation'] == 'quote'))
        for reply in quoting:
            self.f.app('/v1/sources/'+reply['event_id']+'/retirement', {'retired': True, 'expected_revision': reply['revision'],
                       'operation_id': 'scenario-retire-reply-'+reply['event_id'][:16]})
        _, again = self.turn(self.f.message(OWNER, 'یک بار دیگر [[search:PRIVFACT91]]'), OWNER)
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_archive_search' and event['phase'] == 'final'][-1]
        retired = {reply['event_id'] for reply in quoting}
        self.gate('retired_replies_not_retrieved', all(row['id'] not in retired for row in json.loads(final['result'])['sources']))
        # Assistant replies that quoted the fact are separate delivered sources;
        # retirement never implicitly retires another message.
        self.current['observed'] = {'other_sources_quoting_fact': [row['kind'] for row in sources if 'فیروزه' in (row.get('text') or '')]}
        self.gate('original_preserved', self.f.query('nocheh_archive', "SELECT count(*) FROM events WHERE id='"+event_id+"'") == '1')
        restored = self.f.app('/v1/sources/'+event_id+'/retirement', {'retired': False, 'expected_revision': result['revision'],
            'operation_id': 'scenario-restore-'+event_id[:16]})
        self.gate('restore_available', restored.get('retired') is False)

    def document_reply(self):
        # An ordinary file with a caption: the original bytes are kept exactly
        # and the owner still gets one causal reply.
        content = b'%PDF-1.4\n% synthetic invoice DOCMARK55\n'+bytes(range(256))
        file_id = 'doc-'+str(self.f.ids())
        self.f.control({'files': [{'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_path': 'documents/'+file_id+'.pdf',
                                   'file_size': len(content), 'bytes_base64': base64.b64encode(content).decode()}]})
        update = self.f.message(OWNER, None, extra={'caption': 'این فاکتور را نگه دار', 'document': {
            'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_name': 'synthetic-invoice.pdf',
            'mime_type': 'application/pdf', 'file_size': len(content)}})
        event_id, _ = self.turn(update, OWNER)
        expected = hashlib.sha256(content).hexdigest()
        self.wait('document_bytes_archived', lambda: self.f.query('nocheh_archive', "SELECT file_hash FROM artifacts WHERE event_id='"+event_id+"'") == expected, 120)
        self.gate('document_bytes_unchanged', (self.f.directory/'state/files'/expected).read_bytes() == content)

    # Approvals --------------------------------------------------------------

    def proposals(self):
        return self.f.app('/v1/tools/actions')['telegram']

    def action_approval(self):
        topic, wording = 17, 'سلام تیم، جلسه ساعت ۱۷ است ✅'
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        _, text = self.turn(self.f.message(OWNER, 'این پیام را به تاپیک تیم بفرست [[action:'+str(GROUP)+'/topic/'+str(topic)+'|'+wording+']]'), OWNER)
        created = [row for row in self.proposals() if row['id'] not in known]
        self.gate('one_proposal_created', len(created) == 1, count=len(created))
        proposal = created[0]
        self.gate('proposal_exact', proposal['state'] == 'proposed' and proposal['arguments'] == {'destination': str(GROUP)+'/topic/'+str(topic), 'text': wording},
                  arguments=proposal['arguments'])
        time.sleep(5)
        self.gate('nothing_sent_before_approval', not self.replies(before, GROUP, topic))
        stale = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': 'f'*64, 'decision': 'approve'}, allow_error=True)
        self.gate('changed_fingerprint_rejected', stale['status'] == 409, status=stale['status'])
        decision = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'approve',
            'operation_id': 'scenario-approve-'+proposal['id'][:16]})
        self.gate('approved', decision['state'] == 'approved')
        self.wait('action_done', lambda: next(row for row in self.proposals() if row['id'] == proposal['id'])['state'] in ('done', 'ambiguous'), 240)
        final = next(row for row in self.proposals() if row['id'] == proposal['id'])
        self.gate('action_confirmed', final['state'] == 'done', state=final['state'], error=final['error_code'])
        new = self.replies(before, GROUP, topic)
        self.gate('exactly_one_approved_message', len(new) == 1 and new[0]['message']['text'] == wording, count=len(new))
        repeat = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'approve',
            'operation_id': 'scenario-approve-'+proposal['id'][:16]}, allow_error=True)
        time.sleep(5)
        self.gate('repeated_decision_sends_nothing', len(self.replies(before, GROUP, topic)) == 1, status=repeat['status'])

    def action_denial(self):
        topic = 17
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        self.turn(self.f.message(OWNER, 'اینو بفرست [[action:'+str(GROUP)+'/topic/'+str(topic)+'|پیامی که نباید ارسال شود]]'), OWNER)
        proposal = [row for row in self.proposals() if row['id'] not in known][0]
        decision = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'deny'})
        self.gate('denied', decision['state'] == 'rejected')
        time.sleep(10)
        self.gate('denied_action_sends_nothing', not self.replies(before, GROUP, topic))

    def group_current_action(self):
        topic = 18
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        self.turn(self.f.message(GROUP, 'اینجا بفرست [[action:current|یادآوری گروهی]]', topic=topic), GROUP, topic)
        created = [row for row in self.proposals() if row['id'] not in known]
        self.gate('group_proposal_created', len(created) == 1)
        self.gate('current_means_source_topic', created[0]['arguments']['destination'] == str(GROUP)+'/topic/'+str(topic),
                  destination=created[0]['arguments']['destination'])
        time.sleep(5)
        self.gate('group_proposal_waits_for_owner', len(self.replies(before, GROUP, topic)) == 1)
        self.f.app('/v1/tools/telegram-decision', {'id': created[0]['id'], 'fingerprint': created[0]['fingerprint'], 'decision': 'deny'})

    def schedule_fires_and_waits_for_review(self):
        # An owner-private schedule fires on its own cadence, runs once, and its
        # Telegram result waits for exact owner approval before one delivery.
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        started = self.f.query('nocheh_control', 'SELECT now()')
        job = self.f.native('/api/cron/jobs?profile=default', {'name': 'Synthetic reminder', 'prompt': 'یادآوری: آب بخور SCHEDMARK',
                                                             'schedule': 'every 1m', 'deliver': 'telegram', 'repeat': 1})
        self.gate('schedule_created', job.get('deliver') == 'telegram' and job.get('delivery_policy') == 'review_each_result', job=job.get('id'))
        self.wait('definition_captured', lambda: self.f.native('/api/cron/jobs/'+job['id']+'?profile=default').get('managed'), 120)
        run = self.wait('scheduled_run_done', lambda: self.f.query('nocheh_control', "SELECT json_build_object('id',event_id,'state',state,'error',error_code) "
            "FROM managed_runs WHERE channel='scheduler' AND created_at>='"+started+"' AND state IN ('done','failed','cancelled','interrupted')"), 300)
        run = json.loads(run)
        self.gate('scheduled_run_completed', run['state'] == 'done', state=run['state'], error=run['error'])
        proposal = self.wait('result_proposed', lambda: next((row for row in self.proposals() if row['id'] not in known), None), 120)
        self.gate('result_addressed_to_owner_chat', proposal['state'] == 'proposed' and proposal['arguments']['destination'] == str(OWNER),
                  state=proposal['state'], destination=proposal['arguments']['destination'])
        time.sleep(5)
        self.gate('nothing_sent_before_review', not self.replies(before, OWNER))
        self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'approve',
                                                   'operation_id': 'scenario-schedule-'+proposal['id'][:16]})
        self.wait('result_delivered', lambda: next(row for row in self.proposals() if row['id'] == proposal['id'])['state'] in ('done', 'ambiguous'), 240)
        new = self.replies(before, OWNER)
        self.gate('delivered_once_with_exact_text', len(new) == 1 and new[0]['message']['text'] == proposal['arguments']['text'], count=len(new))
        time.sleep(75)
        runs = self.f.query('nocheh_control', "SELECT count(*) FROM managed_runs WHERE channel='scheduler' AND created_at>='"+started+"'")
        self.gate('repeat_limit_honored', runs == '1', runs=runs)
        # The owner can remove a schedule that has finished its runs.
        self.gate('finished_schedule_removed', self.f.native('/api/cron/jobs/'+job['id']+'?profile=default', {}, 'DELETE') == {'ok': True}
                  and all(row['id'] != job['id'] for row in self.f.native('/api/cron/jobs?profile=default')))

    # Audience policy ----------------------------------------------------------

    def participant_not_permitted(self):
        self.turn(self.f.message(GROUP, 'سلام ربات', sender=PARTICIPANT, topic=16), GROUP, 16, expect_reply=False)

    def unselected_group(self):
        self.turn(self.f.message(UNSELECTED_GROUP, 'سلام'), UNSELECTED_GROUP, expect_reply=False)

    def general_after_topics(self):
        self.turn(self.f.message(GROUP, 'سلام در تاپیک عمومی'), GROUP, None)

    # Telegram failures ----------------------------------------------------------

    def deleted_topic(self):
        topic = 19
        before = len(self.f.sent())
        self.f.control({'faults': [{'method': 'sendMessage', 'code': 400, 'description': 'Bad Request: message thread not found'}]})
        update = self.f.message(GROUP, 'تاپیکی که حذف می‌شود', topic=topic)
        self.f.inject(update)
        row = self.finished(self.captured(update), seconds=400)
        stray = [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == GROUP and row['message'].get('message_thread_id') != topic]
        self.gate('no_fallback_to_general_or_other_topic', not stray, stray=len(stray))
        calls = [call for call in self.f.telegram()['calls'] if call['method'] == 'sendMessage' and call['parameters'].get('message_thread_id') is not None
                 and int(call['parameters']['message_thread_id']) == topic]
        self.gate('every_attempt_kept_topic', bool(calls) and all(int(call['parameters']['chat_id']) == GROUP for call in calls), attempts=len(calls))
        self.gate('rejected_by_telegram', row['state'] == 'suppressed' and row['error'] == 'telegram_rejected', state=row['state'], error=row['error'])

    def polling_outage(self):
        self.f.control({'faults': [{'method': 'getUpdates', 'code': 502, 'description': 'Bad Gateway'},
                                   {'method': 'getUpdates', 'code': 500, 'description': 'Internal Server Error'}]})
        self.wait('polling_faults_consumed', lambda: not [fault for fault in self.f.telegram()['faults'] if fault['method'] == 'getUpdates'], 120)
        # The adapter restarts polling after the faults. A reply ready before that
        # restart is never transmitted and is retried by design, which is covered
        # by reply_during_polling_reconnect; this scenario measures recovery after it.
        def reconnected():
            calls = self.f.telegram()['calls']
            fault = max(call['at'] for call in calls if call['method'] == 'getUpdates' and call.get('status') in (500, 502))
            restart = [call['at'] for call in calls if call['method'] in ('deleteWebhook', 'getMe') and call['at'] > fault]
            return restart and any(call['method'] == 'getUpdates' and call.get('status') == 200 and call['at'] > restart[-1] for call in calls)
        self.wait('polling_restarted_after_faults', reconnected, 120)
        self.turn(self.f.message(GROUP, 'بعد از قطعی دریافت', topic=20), GROUP, 20)

    def lost_send_response(self):
        topic = 21
        before = len(self.f.sent())
        self.f.control({'faults': [{'method': 'sendMessage', 'code': 502, 'description': 'Bad Gateway', 'parameters': {'deliver': True}}]})
        update = self.f.message(GROUP, 'پاسخ گم‌شده', topic=topic)
        self.f.inject(update)
        event_id = self.captured(update)
        row = self.finished(event_id, seconds=400)
        time.sleep(60)
        new = self.replies(before, GROUP, topic)
        self.gate('uncertain_send_never_repeated', len(new) == 1, count=len(new), state=row['state'], error=row['error'])
        row = self.f.dispatch(event_id)
        self.gate('uncertain_outcome_not_retried', row['state'] in ('ambiguous', 'done') or row['state'] == 'failed' and row['error'] not in (None,),
                  state=row['state'], error=row['error'], attempts=row['attempts'])

    def blocked_private_then_recovery(self):
        before = len(self.f.sent())
        self.f.control({'faults': [{'method': 'sendMessage', 'code': 403, 'description': 'Forbidden: bot was blocked by the user'}]})
        blocked = self.f.message(OWNER, 'این پاسخ به خاطر مسدودی نمی‌رسد')
        self.f.inject(blocked)
        row = self.finished(self.captured(blocked), seconds=400)
        self.gate('blocked_is_rejected_by_telegram', row['state'] == 'suppressed' and row['error'] == 'telegram_rejected'
                  and not self.replies(before, OWNER), state=row['state'], error=row['error'])
        self.turn(self.f.message(OWNER, 'حالا دوباره در دسترسم'), OWNER)

    def voice(self, content):
        file_id = 'voice-'+str(self.f.ids())
        self.f.control({'files': [{'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_path': 'documents/'+file_id+'.oga',
                                   'file_size': len(content), 'bytes_base64': base64.b64encode(content).decode()}]})
        update = self.f.message(OWNER, None, extra={'voice': {'file_id': file_id, 'file_unique_id': 'u'+file_id, 'duration': 2,
                                                              'mime_type': 'audio/ogg', 'file_size': len(content)}})
        self.f.inject(update)
        event_id = self.captured(update)
        expected = hashlib.sha256(content).hexdigest()
        self.wait('voice_bytes_archived', lambda: self.f.query('nocheh_archive', "SELECT file_hash FROM artifacts WHERE event_id='"+event_id+"'") == expected, 120)
        self.gate('voice_bytes_unchanged', (self.f.directory/'state/files'/expected).read_bytes() == content)
        return update, event_id

    def speech(self, synthetic):
        service = self.f.manifest['services']['chatgpt-speech']
        if not synthetic:
            # Restore the prepared, unavailable speech service so a later run on
            # the same installation can repeat the speech-outage scenarios.
            before = sorted(self.f.directory.glob('telegram-http-*/compose.before.json'))
            if not before:
                raise Failed('original_speech_definition_missing')
            service = self.f.manifest['services']['chatgpt-speech'] = json.loads(before[0].read_text())['services']['chatgpt-speech']
        if synthetic:
            service['command'] = ['python', '/fixture/provider.py', 'speech']
            service['environment']['NOCHEH_INSTALLATION_FIXTURE'] = '1'
            service['volumes'] = [mount for mount in service['volumes'] if mount.get('target') != '/fixture/provider.py']+[
                {'type': 'bind', 'source': str(ROOT/'tools/acceptance/rehearsals/installation-provider.py'), 'target': '/fixture/provider.py', 'read_only': True}]
        path = self.f.directory/'compose.json'
        path.write_text(json.dumps(self.f.manifest));path.chmod(0o600)
        self.f.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'chatgpt-speech')

    def voice_waits_while_speech_unavailable(self):
        if self.f.manifest['services']['chatgpt-speech'].get('command') == ['python', '/fixture/provider.py', 'speech']:
            self.speech(False)
            self.gate('speech_made_unavailable_again')
        before = len(self.f.sent())
        update, event_id = self.voice(b'OggS\x00\x02synthetic-voice SPEECH:\xd9\xbe\xdb\x8c\xd8\xa7\xd9\x85 \xd9\x85\xd9\x86\xd8\xaa\xd8\xb8\xd8\xb1\n\xff'*4)
        self.state['waiting_voice'] = (update, event_id)
        time.sleep(30)
        row = self.f.dispatch(event_id)
        self.gate('voice_not_answered_without_transcript', row is None or row['state'] in ('pending', 'running') and not self.replies(before, OWNER),
                  dispatch=row)
        self.turn(self.f.message(OWNER, 'یک پیام متنی بعد از ویس'), OWNER)

    def voice_recovers_when_speech_returns(self):
        update, event_id = self.state['waiting_voice']
        self.speech(True)
        row = self.finished(event_id, seconds=900)
        self.gate('waiting_voice_answered_after_recovery', row['state'] == 'done', state=row['state'], error=row['error'], attempts=row['attempts'])
        transcripts = self.f.query('nocheh_derived', "SELECT count(*) FROM derived_artifacts WHERE kind='transcript' AND event_id='"+event_id+"'")
        self.current['observed'] = {'transcripts': transcripts}

    def voice_transcript_drives_turn(self):
        before = len(self.f.sent())
        _, event_id = self.voice(b'OggS\x00\x02SPEECH:'+'یادآوری صوتی VOICEMARK77 [[search:VOICEMARK77]]'.encode()+b'\n\xff')
        row = self.finished(event_id, seconds=600)
        self.gate('voice_dispatch_done', row['state'] == 'done', state=row['state'], error=row['error'])
        new = self.replies(before, OWNER)
        self.gate('one_voice_reply', len(new) == 1, count=len(new))
        self.gate('transcript_reached_model_as_turn', any(event.get('argument') == 'VOICEMARK77' and event['phase'] == 'final' for event in self.f.brain()))

    def voice_blank_transcript_is_terminal(self):
        before = len(self.f.sent())
        _, event_id = self.voice(b'OggS\x00\x02BLANK synthetic silence\n\xff')
        time.sleep(45)
        row = self.f.dispatch(event_id)
        retrievals = self.f.query('nocheh_control', "SELECT json_agg(json_build_object('state',state,'attempts',attempts)) FROM workflow_registry "
                                  "WHERE family='preparation' AND job_id LIKE '%"+event_id+"%'")
        self.current['observed'] = {'dispatch': row, 'preparation': retrievals}
        self.gate('blank_voice_not_answered_as_transcribed', not self.replies(before, OWNER), dispatch=row)
        self.gate('blank_voice_closed_visibly', row is not None and row['state'] == 'suppressed' and row['error'] == 'invalid_transcription_response',
                  dispatch=row)
        started = time.monotonic()
        self.turn(self.f.message(OWNER, 'بعد از ویس نامفهوم'), OWNER)
        self.gate('next_message_not_held', time.monotonic()-started < 90, seconds=round(time.monotonic()-started, 1))

    # Owner authority ------------------------------------------------------------

    def owner_directory_lists_conversations(self):
        topic, name = 31, 'برنامه‌ریزی تیم'
        root = {'message_id': topic, 'date': 1, 'chat': {'id': GROUP, 'type': 'supergroup', 'is_forum': True}, 'forum_topic_created': {'name': name, 'icon_color': 7322096}}
        self.turn(self.f.message(GROUP, 'سلام از تاپیک برنامه‌ریزی', topic=topic, reply_to=root), GROUP, topic)
        _, text = self.turn(self.f.message(OWNER, 'گروه‌ها و تاپیک‌هایم را فهرست کن [[owner:conversations]]'), OWNER)
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_owner_read' and event['phase'] == 'final'][-1]
        items = json.loads(final['result'])['items']
        named = {item['space_id']: item['name'] for item in items}
        self.gate('owner_sees_groups', str(GROUP) in named and str(OTHER_GROUP) in named, groups=sorted(k for k in named if '/topic/' not in k))
        self.gate('topic_named_from_root_message', named.get(str(GROUP)+'/topic/'+str(topic)) == name, name=named.get(str(GROUP)+'/topic/'+str(topic)))
        self.turn(self.f.message(GROUP, 'فهرست گروه‌ها [[owner:conversations]]', topic=11), GROUP, 11)
        final = [event for event in self.f.brain() if event.get('tool') == 'nocheh_owner_read' and event['phase'] == 'final'][-1]
        self.gate('group_turn_cannot_read_owner_directory', 'owner_read_unavailable' in final['result'] and 'items' not in final['result'])

    def unparseable_update_does_not_wedge_polling(self):
        # An update the pinned SDK cannot parse (a required field is missing)
        # must not stop polling; its original is still captured whole.
        broken = self.f.message(GROUP, 'ریشهٔ ناقص', topic=32, reply_to={'message_id': 32, 'date': 1, 'chat': {'id': GROUP, 'type': 'supergroup'},
                                                                         'forum_topic_created': {'name': 'بدون رنگ'}})
        after = self.f.message(OWNER, 'پیام بعد از به‌روزرسانی ناقص')
        before = len(self.f.sent())
        self.f.inject(broken, after)
        self.gate('broken_original_captured', bool(self.captured(broken)))
        self.wait('queue_acknowledged', lambda: not [u for u in self.f.telegram()['updates'] if u['update_id'] <= after['update_id']], 120)
        row = self.finished(self.captured(after))
        self.gate('later_message_answered', row['state'] == 'done' and len(self.replies(before, OWNER)) == 1, state=row['state'])
        health = self.f.http('/health', service='hermes', port=8781)
        self.gate('unparseable_update_visible', (health.get('telegram_details') or {}).get('unparseable_updates', 0) >= 1, health=health.get('telegram_details'))

    def telegram_refresh_names(self):
        self.f.control({'chats': [{'id': GROUP, 'type': 'supergroup', 'title': 'Synthetic Forum Refreshed', 'is_forum': True},
                                  {'id': OTHER_GROUP, 'type': 'group', 'migrate_to_chat_id': -1001234567890}]})
        before = len(self.f.sent())
        result = self.f.app('/v1/telegram/chats/refresh', {})
        states = {chat['chat_id']: chat for chat in result['chats']}
        self.gate('refresh_reads_telegram', states[str(GROUP)]['state'] == 'available' and states[str(GROUP)]['title'] == 'Synthetic Forum Refreshed')
        self.gate('upgraded_group_reports_new_id', states[str(OTHER_GROUP)]['state'] == 'migrated' and states[str(OTHER_GROUP)]['migrate_to_chat_id'] == '-1001234567890')
        self.gate('refresh_sends_nothing', len(self.f.sent()) == before)
        directory = {item['space_id']: item for item in self.f.app('/v1/conversations?limit=100')['items']}
        self.gate('directory_shows_migration', directory[str(OTHER_GROUP)].get('telegram', {}).get('migrate_to_chat_id') == '-1001234567890')

    def owner_freedom_executes_owner_requests(self):
        topic, wording = 17, 'پیام بدون تأیید از طرف مالک'
        current = self.f.app('/v1/owner-autonomy')
        self.gate('approval_required_by_default', current['mode'] == 'approval_required')
        enabled = self.f.app('/v1/owner-autonomy', {'mode': 'owner_requests_execute', 'expected_revision': current['revision'],
                                                    'operation_id': 'scenario-freedom-'+str(self.f.ids())})
        try:
            known = {row['id'] for row in self.proposals()}
            before = len(self.f.sent())
            self.turn(self.f.message(OWNER, 'بفرست [[action:'+str(GROUP)+'/topic/'+str(topic)+'|'+wording+']]'), OWNER)
            created = [row for row in self.proposals() if row['id'] not in known]
            self.gate('owner_request_approved_by_setting', len(created) == 1 and created[0]['state'] in ('approved', 'running', 'done'), state=created[0]['state'])
            self.wait('sent_without_decision', lambda: [row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording], 180)
            self.gate('sent_once', len([row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording]) == 1)
            known = {row['id'] for row in self.proposals()}
            self.turn(self.f.message(GROUP, 'اینجا بفرست [[action:current|درخواست گروهی]]', topic=18), GROUP, 18)
            group = [row for row in self.proposals() if row['id'] not in known]
            self.gate('group_request_still_waits', len(group) == 1 and group[0]['state'] == 'proposed')
            self.f.app('/v1/tools/telegram-decision', {'id': group[0]['id'], 'fingerprint': group[0]['fingerprint'], 'decision': 'deny'})
        finally:
            self.f.app('/v1/owner-autonomy', {'mode': 'approval_required', 'expected_revision': enabled['revision'],
                                              'operation_id': 'scenario-freedom-reset-'+str(self.f.ids())})

    def launcher_stop_mid_turn(self):
        before = len(self.f.sent())
        update = self.f.message(OWNER, 'یک جواب طولانی‌تر [[long:3000]]')
        self.f.inject(update)
        event_id = self.captured(update)
        listed = lambda: subprocess.check_output(['docker', 'ps', '-q', '--filter', 'label=nocheh.role=isolated-turn'], text=True).split()
        self.wait('turn_container_running', listed, 120, 1)
        self.f.run('stop', '-t', '30', 'hermes-agent-sb')
        time.sleep(3)
        self.gate('no_turn_container_left', not subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=nocheh.role=isolated-turn'], text=True).split())
        self.f.run('up', '-d', '--no-build', '--no-deps', '--wait', 'hermes-agent-sb')
        row = self.finished(event_id, seconds=400)
        self.gate('interrupted_turn_recovered', row['state'] == 'done', state=row['state'], attempts=row['attempts'])
        self.gate('one_reply_after_recovery', len(self.replies(before, OWNER)) >= 1 and
                  len({json.loads(r['parameters'].get('reply_parameters', '{}')).get('message_id') for r in self.replies(before, OWNER)}) == 1)

    def burst_with_voice_in_order(self):
        before = len(self.f.sent())
        texts = [self.f.message(OWNER, 'پیام پشت‌سرهم '+str(index)) for index in range(1, 4)]
        content = b'OggS\x00\x02SPEECH:'+'ویس وسط پیام‌ها'.encode()+b'\n\xff'
        file_id = 'voice-'+str(self.f.ids())
        self.f.control({'files': [{'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_path': 'documents/'+file_id+'.oga',
                                   'file_size': len(content), 'bytes_base64': base64.b64encode(content).decode()}]})
        voice = self.f.message(OWNER, None, extra={'voice': {'file_id': file_id, 'file_unique_id': 'u'+file_id, 'duration': 2,
                                                             'mime_type': 'audio/ogg', 'file_size': len(content)}})
        last = self.f.message(OWNER, 'و پیام آخر')
        updates = texts+[voice, last]
        self.f.inject(*updates)
        for update in updates:
            row = self.finished(self.captured(update), seconds=600)
            self.gate('burst_reply_done', row['state'] == 'done', state=row['state'], attempts=row['attempts'])
        new = self.replies(before, OWNER)
        targets = [json.loads(row['parameters'].get('reply_parameters', '{}')).get('message_id') for row in new]
        self.gate('one_reply_each_in_telegram_order', targets == [update['message']['message_id'] for update in updates], targets=targets)

    def restart_preserves_receipts(self):
        sent = len(self.f.sent())
        self.wait('updates_acknowledged', lambda: not self.f.telegram()['updates'], 120)
        self.f.run('restart', '--no-deps', 'hermes')
        self.f.run('up', '-d', '--no-build', '--no-deps', '--wait', 'hermes')
        self.wait('polling_reconnected', lambda: self.f.http('/health', service='hermes', port=8781)['telegram'] == 'connected', 120)
        time.sleep(10)
        self.gate('restart_sends_nothing', len(self.f.sent()) == sent)
        self.turn(self.f.message(OWNER, 'بعد از راه‌اندازی دوباره'), OWNER)

    def granted_participant(self):
        def apply(access):
            for service in self.f.manifest['services'].values():
                environment = service.get('environment') or {}
                if isinstance(environment, dict) and 'TELEGRAM_GROUP_ACCESS' in environment:
                    environment['TELEGRAM_GROUP_ACCESS'] = json.dumps(access)
            path = self.f.directory/'compose.json'
            path.write_text(json.dumps(self.f.manifest));path.chmod(0o600)
            names = [name for name, service in self.f.manifest['services'].items()
                     if isinstance(service.get('environment'), dict) and 'TELEGRAM_GROUP_ACCESS' in service['environment']]
            self.f.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', *names)
            self.wait('polling_reconnected', lambda: self.f.http('/health', service='hermes', port=8781)['telegram'] == 'connected', 180)
            return names
        names = apply({str(GROUP): {'granted': [str(PARTICIPANT)], 'denied': []}})
        self.current['recreated'] = names
        self.turn(self.f.message(GROUP, 'سلام، اجازه دارم؟', sender=PARTICIPANT, topic=22), GROUP, 22)
        apply({str(GROUP): {'granted': [], 'denied': [str(PARTICIPANT)]}})
        self.turn(self.f.message(GROUP, 'هنوز اجازه دارم؟', sender=PARTICIPANT, topic=22), GROUP, 22, expect_reply=False)

    # Operations -------------------------------------------------------------------

    def storage_report(self):
        # The owner's `./bin/nocheh storage` report and the Monitoring Storage
        # section read the same measurements; both must see every store.
        from tools.operations.installation.storage import report
        result = report(self.f.directory/'state', command=self.f.command, env=dict(os.environ))
        measured = {row['database']: row for row in result['databases']}
        expected = {'nocheh_archive', 'nocheh_derived', 'nocheh_control', 'nocheh_inngest', 'honcho_experiment'}
        self.gate('every_store_measured', set(measured) == expected and all(row['state'] == 'measured' for row in measured.values()),
                  states={name: row['state'] for name, row in measured.items()})
        self.gate('archive_events_listed', any(table['table'] == 'events' for table in measured['nocheh_archive']['largest_tables']))
        self.gate('state_folders_listed', {'files', 'spool'} <= {row['path'] for row in result['state_folders']},
                  folders=[row['path'] for row in result['state_folders']])
        self.gate('retention_reported', result['retention_days'] == 14 and result['docker_logs']['max_files_per_container'] >= 1)
        self.current['observed'] = {'bytes': {name: row.get('bytes') for name, row in measured.items()},
                                    'state_bytes': {row['path']: row['bytes'] for row in result['state_folders']}}
        raw = subprocess.run(self.f.command+['exec', '-T', 'nocheh-dashboard', 'python3', '-m', 'tools.runtime.management'],
                             input=json.dumps({'operation': 'storage.report'}), text=True, capture_output=True, timeout=180)
        monitoring = json.loads(raw.stdout.strip().splitlines()[-1]) if raw.stdout.strip() else {'error': 'no_output'}
        databases = {row['database']: row['state'] for row in (monitoring.get('result') or {}).get('databases', [])}
        self.gate('monitoring_storage_measures_every_store', set(databases) == expected and set(databases.values()) == {'measured'},
                  error=monitoring.get('error'), states=databases)

    def stage_timings(self):
        # T6 of the stage timing plan: one per-stage breakdown for every reply
        # this run verified, stages that add up to the reply time, no content,
        # and the same rows through the owner's `admin timings` rendering.
        import contextlib
        import io
        from tools.cli.admin import redact, render_timings
        seen, rows, incomplete, mismatched, leaked = set(), [], [], [], []
        allowed = {'event_id', 'started_at', 'ended_at', 'reply_ms', 'complete', 'attempts', 'stages', 'unmeasured_ms'}
        if not self.replied:  # A focused --only run measures the installation's recent replies instead.
            self.replied = [('recent', row['event_id']) for row in self.f.app('/v1/workflows/timings?limit=50')['recent']]
        for scenario, event_id in self.replied:
            if event_id in seen:
                continue
            seen.add(event_id)
            value = self.f.app('/v1/workflows/timings/'+event_id)
            if set(value) - allowed or any(set(stage) != {'stage', 'label', 'category', 'ms', 'calls'} for stage in value['stages']):
                leaked.append(scenario)
            if not value['complete']:
                incomplete.append(scenario)
            total = sum(stage['ms'] for stage in value['stages'])
            if value['reply_ms'] is None or abs(total-value['reply_ms']) > len(value['stages']):
                mismatched.append(scenario)
            rows.append({'scenario': scenario, 'event': event_id[:12], 'reply_ms': value['reply_ms'], 'attempts': value['attempts'],
                         'complete': value['complete'], 'stages': {stage['stage']: stage['ms'] for stage in value['stages']}})
        summary = self.f.app('/v1/workflows/timings?limit=200')
        (self.report/'timings.json').write_text(json.dumps({'replies': rows, 'summary': summary}, indent=2, ensure_ascii=False)+'\n')
        self.current['observed'] = {'replies': len(rows), 'reply_ms_p50': summary['reply_ms_p50'], 'reply_ms_p95': summary['reply_ms_p95'],
                                    'stages': {stage['stage']: [stage['ms_p50'], stage['ms_p95']] for stage in summary['stages']}}
        self.gate('breakdown_for_every_reply', bool(rows), replies=len(rows))
        self.gate('breakdowns_carry_no_content', not leaked, scenarios=leaked)
        self.gate('every_breakdown_complete', not incomplete, scenarios=incomplete)
        self.gate('stages_add_up_to_reply_time', not mismatched, scenarios=mismatched)
        self.gate('summary_has_percentiles', summary['messages'] > 0 and summary['reply_ms_p50'] is not None, messages=summary['messages'])
        output = io.StringIO()
        sample = self.f.app('/v1/workflows/timings/'+self.replied[-1][1])
        with contextlib.redirect_stdout(output):
            rendered = render_timings(redact(sample)) and render_timings(redact(summary))
        self.gate('admin_timings_renders_every_stage', rendered and '[redacted]' not in json.dumps(redact(sample))
                  and all(stage['label'] in output.getvalue() for stage in sample['stages']))


ORDER = ['reply_during_polling_reconnect', 'ordinary_private', 'edit_is_silent', 'reaction_is_silent', 'general_after_topics', 'burst_in_order', 'private_burst_in_order', 'long_reply_chunks',
         'intentional_silence', 'empty_answer_is_not_silence', 'private_fact_and_search', 'owner_private_context', 'group_cannot_see_private',
         'owner_recall', 'secret_is_guarded', 'document_reply', 'action_approval', 'action_denial', 'group_current_action', 'schedule_fires_and_waits_for_review', 'participant_not_permitted',
         'unselected_group', 'retirement_hides_fact', 'voice_waits_while_speech_unavailable', 'voice_recovers_when_speech_returns',
         'voice_transcript_drives_turn', 'burst_with_voice_in_order', 'voice_blank_transcript_is_terminal',
         'owner_directory_lists_conversations', 'unparseable_update_does_not_wedge_polling', 'telegram_refresh_names', 'owner_freedom_executes_owner_requests', 'launcher_stop_mid_turn', 'deleted_topic', 'polling_outage', 'lost_send_response',
         'blocked_private_then_recovery', 'restart_preserves_receipts', 'granted_participant', 'storage_report', 'stage_timings']


# With real model answers (tools.acceptance.real_model_fixture) the scripted
# directives mean nothing; these scenarios check delivery, order, audience,
# recovery and effects only, and save each answer for review.
REAL_MODEL_ORDER = ['reply_during_polling_reconnect', 'ordinary_private', 'edit_is_silent', 'reaction_is_silent', 'general_after_topics',
                    'burst_in_order', 'private_burst_in_order', 'document_reply', 'participant_not_permitted', 'unselected_group',
                    'schedule_fires_and_waits_for_review', 'voice_waits_while_speech_unavailable',
                    'voice_recovers_when_speech_returns', 'burst_with_voice_in_order', 'deleted_topic', 'polling_outage',
                    'lost_send_response', 'blocked_private_then_recovery', 'restart_preserves_receipts', 'storage_report', 'stage_timings']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--only', nargs='*', choices=ORDER)
    parser.add_argument('--real-model', action='store_true', help='Run REAL_MODEL_ORDER after real_model_fixture switched the model route')
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_relative_to(ROOT/'data/acceptance/results'):
        raise ValueError('owned_fixture_directory_required')
    fixture = Fixture(directory)
    if fixture.query('nocheh_control', "SELECT current_setting('cluster_name')") != 'nocheh-installation-fixture':
        raise ValueError('synthetic_cluster_required')
    if fixture.manifest['services']['hermes'].get('command') != ['python', '-m', 'tools.acceptance.telegram_runtime']:
        raise ValueError('run_telegram_rehearsal_first')
    report = directory/('telegram-scenarios-'+str(time.time_ns()))
    report.mkdir(mode=0o700)
    initial = fixture.telegram()
    if initial['faults']:
        raise ValueError('previous_fixture_faults_pending')
    scenarios = Scenarios(fixture, report)
    scenarios.state = {}
    real = (directory/'route-preflight.json').exists()
    if args.real_model != real:
        raise ValueError('real_model_fixture_required' if args.real_model else 'scripted_fixture_required')
    scenarios.real_model = real
    for name in args.only or (REAL_MODEL_ORDER if real else ORDER):
        scenarios.execute(name, getattr(scenarios, name))
    final = fixture.telegram()
    project_networks = {value['name'] for value in fixture.manifest['networks'].values()}
    def turns():
        listed = subprocess.check_output(['docker', 'ps', '-a', '--format', '{{json .}}', '--filter', 'label=nocheh.role=isolated-turn'], text=True)
        return [row for row in map(json.loads, filter(None, listed.splitlines())) if set(row.get('Networks', '').split(',')) & project_networks]
    # Native memory reviews keep launching short isolated turns after a burst.
    # They must drain on their own; a turn left behind after that is a leak.
    # A review waiting for a receipt is reported separately: it launches no turn.
    count = lambda states: fixture.query('nocheh_control', "SELECT count(*) FROM workflow_registry WHERE family='memory_review' "
                                         "AND job_id LIKE 'native:%' AND "+states)
    backlog = lambda: count("(state IN ('queued','running') OR state='waiting' AND waiting_reason IS DISTINCT FROM 'receipt_pending')")
    started, quiet, pending = time.monotonic(), None, backlog()
    while time.monotonic()-started < 1800:
        if turns() or backlog() != '0':
            quiet = None
        elif quiet is None:
            quiet = time.monotonic()
        elif time.monotonic()-quiet >= 30:
            break
        time.sleep(5)
    lingering = turns()
    scenarios.current = {'scenario': 'no_lingering_isolated_turns', 'gates': [], 'passed': not lingering}
    scenarios.current['observed'] = {'containers': len(lingering), 'native_reviews_pending_at_end': int(pending),
                                     'native_reviews_left': int(backlog()),
                                     'native_reviews_awaiting_receipt': int(count("state='waiting' AND waiting_reason='receipt_pending'")), 'drain_seconds': round(time.monotonic()-started, 1)}
    scenarios.results.append(scenarios.current)
    summary = {'passed': all(row['passed'] for row in scenarios.results), 'live_acceptance': False,
               'provider': 'existing-model-route' if real else 'deterministic-fixture-with-scripted-brain', 'scenarios': scenarios.results,
               'unknown_methods': final['unknown'][len(initial['unknown']):], 'stats': fixture.http('/fixture/stats')}
    (report/'result.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps({'passed': summary['passed'], 'failed': [row['scenario'] for row in scenarios.results if not row['passed']],
                      'unknown_methods': summary['unknown_methods'], 'report': str(report/'result.json')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
