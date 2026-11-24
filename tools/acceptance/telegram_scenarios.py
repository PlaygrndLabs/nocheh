"""Personal-use Telegram scenarios on an owned HTTP Bot API fixture.

Extends tools.acceptance.telegram_rehearsal on the same synthetic installation:
actual polling by Nocheh's Telegram service, Hermes, three stores, workflows,
Honcho and the scripted fixture agent. Directives such as ``[[search:...]]``
make the fixture model request real Nocheh tools; they test plumbing,
isolation and effects, not judgement.
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
import urllib.parse
from tools.paths import ROOT
from tools.acceptance import canaries
from tools.acceptance.telegram_rehearsal import (MINI_APP_SERVICE, TELEGRAM_SERVICE, archived_delivery, sent_buttons, telegram_health,
                                                 validate_fixture, wait_telegram_connected)

# Only the owner adds Nocheh to a group (ADR-0253). The owner adds it to GROUP and OTHER_GROUP when the fake Telegram
# connects (telegram_rehearsal.adopt), and answers No project on the card that follows. UNSELECTED_GROUP is a group
# Nocheh is in that nobody added it to while it watched: it stays Off and silent and is never left.
OWNER, GROUP, OTHER_GROUP, UNSELECTED_GROUP, PARTICIPANT = 123, -10042, -10043, -10099, 777
# A third group the owner adds Nocheh to at the start, so two groups can share a project while GROUP stays in none
# (project_groups_stay_apart).
THIRD_GROUP = -10044
# Groups Nocheh first sees after step 2b, so their Nocheh ids are digests (ADR-0252). NEW_GROUP (NG1) is seen Off until
# the owner adds Nocheh there, and joins P1; UPGRADED_GROUP is a basic group Telegram upgrades to UPGRADED_SUPERGROUP,
# which Nocheh learns from Telegram's service messages; REFRESHED_GROUP is one whose upgrade the owner's refresh finds.
# No other scenario posts in either upgraded group.
NEW_GROUP, NEW_TOPIC = -10045, 5
UPGRADED_GROUP, UPGRADED_SUPERGROUP = -4046, -10047
REFRESHED_GROUP, REFRESHED_SUPERGROUP = -4048, -10049
MENTION = '@synthetic_fixture_bot'
# The fixed, editable reply in a group for anyone who may not use Nocheh there: a stranger, or a member who is paused or
# switched off there. It comes at most once a UTC day per person and group (src/prompts.ts).
NOT_ALLOWED = 'Sorry, in this group I only work with the owner and the owner\'s members.'
CANARY = 'fixture-secret-ORCHID-2718'
PRIVATE_FACT = 'رنگ مورد علاقه‌ی خواهرم فیروزه‌ای است PRIVFACT91'



def isolated_turns(*options):
    """List isolated turn containers, retrying a transient Docker CLI failure."""
    for attempt in range(3):
        try:
            return subprocess.check_output(['docker', 'ps', *options, '--filter', 'label=nocheh.role=isolated-turn'], text=True)
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(2)


def synthetic_png(size=8):
    """A small plain white PNG that decodes, since the vision tool decodes an image before reading it."""
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack('>I', len(data))+kind+data+struct.pack('>I', zlib.crc32(kind+data) & 0xffffffff)
    rows = b''.join(b'\x00'+b'\xff\xff\xff'*size for _ in range(size))
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            +chunk(b'IDAT', zlib.compress(rows))+chunk(b'IEND', b''))


def synthetic_pdf(lines):
    """A minimal one-page PDF with a Helvetica text layer."""
    stream = '\n'.join('BT /F1 12 Tf 20 %d Td (%s) Tj ET' % (760-row*14, line) for row, line in enumerate(lines))
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
               '<< /Length %d >>\nstream\n%s\nendstream' % (len(stream), stream), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out, offsets = '%PDF-1.4\n', []
    for index, value in enumerate(objects):
        offsets.append(len(out));out += '%d 0 obj\n%s\nendobj\n' % (index+1, value)
    xref = len(out)
    out += 'xref\n0 %d\n0000000000 65535 f \n' % (len(objects)+1) + ''.join('%010d 00000 n \n' % offset for offset in offsets)
    out += 'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects)+1, xref)
    return out.encode('latin-1')

def synthetic_wav(seconds, rate=64):
    """A plain square-wave WAV, `seconds` long at a very low rate, so a recording of many minutes stays small enough to
    hand to the fixture. It is a tone, not silence, so nothing trims it away."""
    import io
    import wave
    out = io.BytesIO()
    with wave.open(out, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(1)
        audio.setframerate(rate)
        audio.writeframes(bytes([200, 200, 56, 56])*(rate*seconds//4))
    return out.getvalue()


# The note transcripts cut to 15 minutes ended with before ADR-0264; no transcript carries it now.
OLD_FIRST_PART = '[Only the first 15 minutes of this recording were transcribed; its original audio is kept.]'


class Failed(AssertionError):
    pass


class Fixture:
    def __init__(self, directory):
        self.directory = directory
        info = json.loads((directory/'fixture.json').read_text())
        self.manifest = json.loads((directory/'compose.json').read_text())
        self.project = validate_fixture(directory, info, self.manifest)
        # Directives such as [[long:...]] need the scripted model; a real-model relay ignores them.
        if self.manifest['services']['model-fixture']['environment'].get('NOCHEH_FIXTURE_UPSTREAM'):
            raise ValueError('scripted_model_required: restore compose.before-model.json or use a fresh fixture')
        self.command = ['docker', 'compose', '-p', self.project, '-f', str(directory/'compose.json')]
        self.next_id = None

    def run(self, *args, **kwargs):
        return subprocess.run(self.command+list(args), check=True, **kwargs)

    def query(self, database, sql):
        return subprocess.check_output(self.command+['exec', '-T', 'nocheh-db', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-U', 'nocheh', '-d', database, '-c', sql], text=True).strip()

    def http(self, path, body=None, service='model-fixture', port=8317, allow_error=False):
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

    def session(self):
        """What `docker compose exec` passes Hermes's dashboard session token with (ADR-0295): by name only, its value in
        this process's environment, never on a command line. nocheh-app itself does not hold it."""
        token = self.manifest['services']['hermes']['environment'].get('NOCHEH_HERMES_SESSION_TOKEN')
        if not token: raise Failed('native_session_token_missing: make a fresh fixture')
        return ['-e', 'NOCHEH_HERMES_SESSION_TOKEN'], {**os.environ, 'NOCHEH_HERMES_SESSION_TOKEN': token}

    def native(self, path, body=None, method=None, allow_error=False):
        """The owner's native administration route, as `./bin/nocheh cron` calls it. `allow_error` returns {status, body}
        instead of failing on an error."""
        script = """const [path,encoded,method,tolerant]=process.argv.slice(1),body=JSON.parse(encoded);
const response=await fetch('http://hermes:8785'+path,{method:method||(body===null?'GET':'POST'),
headers:{'content-type':'application/json','X-Hermes-Session-Token':process.env.NOCHEH_HERMES_SESSION_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
const text=await response.text();if(!response.ok&&tolerant!=='1')throw Error('native_http_'+response.status+':'+text.slice(0,300));
console.log(tolerant==='1'?JSON.stringify({status:response.status,body:text?JSON.parse(text):null}):text);"""
        named, env = self.session()
        return json.loads(subprocess.check_output(self.command+['exec', '-T', *named, 'nocheh-app', 'node', '--input-type=module', '-e', script,
            path, json.dumps(body), method or '', '1' if allow_error else '0'], text=True, env=env))

    def mini(self, path, method='GET', body=None, headers=None):
        """A call to the Telegram mini app's edge (nocheh-miniapp) as a phone makes it through the tunnel: run inside that
        container, to its own port, with no Bearer and no service token. Returns {status, headers, text}; `headers` holds
        the answer's cache-control and content-security-policy."""
        self.mini_running()
        script = """const [path,method,encoded,extra]=process.argv.slice(1),body=JSON.parse(encoded);
const headers=JSON.parse(extra);if(body!==null)headers['content-type']='application/json';
const response=await fetch('http://127.0.0.1:8788'+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
console.log(JSON.stringify({status:response.status,headers:{'cache-control':response.headers.get('cache-control'),
'content-security-policy':response.headers.get('content-security-policy')},text:await response.text()}));"""
        return json.loads(subprocess.check_output(self.command+['exec', '-T', MINI_APP_SERVICE, 'node', '--input-type=module', '-e', script,
                                                                path, method, json.dumps(body), json.dumps(headers or {})], text=True))

    def mini_running(self):
        """The mini app's edge, started again when gone. The fixture runs it without the saved address and tunnel token that
        turn the mini app on, so a settings Apply in an earlier scenario removes it, as Apply does on an install with the
        mini app off."""
        if MINI_APP_SERVICE not in self.manifest['services']:
            raise Failed('mini_app_not_in_fixture: run telegram_rehearsal with --miniapp-image')
        if not subprocess.check_output(self.command+['ps', '-q', MINI_APP_SERVICE], text=True).strip():
            self.run('up', '-d', '--no-build', '--no-deps', '--wait', MINI_APP_SERVICE)

    def mini_reaches(self, url):
        """Whether the mini app's edge can open an address at all (any answer counts), from inside its container."""
        self.mini_running()
        script = """try{await fetch(process.argv[1],{signal:AbortSignal.timeout(10000)});console.log('true');}catch{console.log('false');}"""
        return subprocess.check_output(self.command+['exec', '-T', MINI_APP_SERVICE, 'node', '--input-type=module', '-e', script, url],
                                       text=True).strip() == 'true'

    def launch(self, user, **options):
        """Launch data the fake Telegram signs for the Telegram user `user`, as Telegram hands it to the Mini App they opened
        from their menu button: auth_date (default now), chat_type, first_name, language_code, bot_id or other_key."""
        return self.http('/fixture/telegram/launch', {'user_id': int(user), **options})['init_data']

    def member_http(self, path, user=None, body=None, method=None, launch=None, label=None):
        """A call of the members' page (/api/member<path>) through the mini app's edge, with launch data for `user` (or the
        given `launch`) and nothing else: no Bearer, no session. Returns {status, body} with the JSON body, and keeps the
        answer (never the launch data) in the fixture's mini-app-responses.jsonl for the HTTP canary sweep."""
        launch = self.launch(user) if launch is None else launch
        answer = self.mini('/api/member'+path, method or ('GET' if body is None else 'POST'), body, {'x-telegram-init-data': launch})
        try:
            parsed = json.loads(answer['text']) if answer['text'] else None
        except ValueError:
            parsed = {'raw': answer['text'][:500]}
        canaries.log_http(self.directory, {'user': None if user is None else int(user), 'label': label, 'method': method or ('GET' if body is None else 'POST'),
                                           'path': path.split('?', 1)[0], 'status': answer['status'], 'cache': answer['headers'].get('cache-control'),
                                           'body': answer['text']})
        return {'status': answer['status'], 'body': parsed, 'cache': answer['headers'].get('cache-control')}

    def telegram(self):
        return self.http('/fixture/telegram')

    def conversations(self):
        """Every chat in the owner's chat list (GET /v1/conversations), page by page."""
        items, after = [], None
        while True:
            page = self.app('/v1/conversations?limit=100'+('&after='+urllib.parse.quote(after, safe='') if after else ''))
            items += page['items']
            after = page.get('next_cursor')
            if not after:
                return items

    def chat(self, app_id, topic=None, seconds=60):
        """The Nocheh id of a Telegram chat, or of one of its topics, found by its Telegram id labels in the owner's chat
        list (ADR-0252). A chat Nocheh knew before step 2b keeps its stored value as its id; one first seen later, a topic
        included, has a digest id, so scenarios never build an id from Telegram's. Waits for a chat just captured."""
        external, started = str(app_id), time.monotonic()
        while True:
            items = self.conversations()
            chat = next((item['space_id'] for item in items if item.get('kind') in ('private', 'group') and any(
                label.get('app') == 'telegram' and label.get('external') == external for label in item.get('app_ids') or [])), None)
            found = chat if topic is None or chat is None else next((item['space_id'] for item in items if item.get('kind') == 'topic'
                                                                   and item.get('parent_space') == chat and str(item.get('topic_key')) == str(topic)), None)
            if found:
                return found
            if time.monotonic()-started >= seconds:
                raise Failed('chat_not_in_directory:'+external+('' if topic is None else ':'+str(topic)))
            time.sleep(2)

    def chat_item(self, app_id, topic=None):
        """The owner's chat list item of a Telegram chat or topic."""
        chat = self.chat(app_id, topic)
        return next(item for item in self.conversations() if item['space_id'] == chat)

    def ids(self):
        """A new update id, also used as a message id. The tester's are multiples of ten: the fake Telegram numbers the
        updates it sends on its own, such as the one reporting the bot's own leave, in between (telegram_mock.next_update_id)."""
        if self.next_id is None:
            state = self.telegram()
            known = [item['update_id'] for item in state['updates']]+[state['offset'], state.get('last_update_id', 0), int(time.time())]
            self.next_id = (max(known)+1000)//10*10
        self.next_id += 10
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

    def agent(self):
        return self.http('/fixture/agent')['events']

    def control(self, body):
        return self.http('/fixture/telegram/control', body)


class Scenarios:
    def __init__(self, fixture, report):
        self.f, self.report, self.results, self.current = fixture, report, [], None
        # Every (scenario, event) whose single causal reply was verified; the
        # stage timing scenario reads one breakdown for each of them.
        self.replied = []

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

    @staticmethod
    def is_card(row):
        """An approval card: sent with Approve and Reject buttons (settling it later removes them). A reply whose one
        button is Answer privately (ADR-0249) is a reply, not a card."""
        markup = row['parameters'].get('reply_markup') or '{}'
        rows = (json.loads(markup) if isinstance(markup, str) else markup).get('inline_keyboard') or []
        return any(not str(button.get('callback_data') or '').startswith('np') for line in rows for button in line)

    def topic_chat(self, chat, topic):
        """The Nocheh id of a group's topic. Nocheh learns a topic from a message in it (ADR-0252), so a topic nothing was
        said in yet first gets a message nobody addresses."""
        try:
            return self.f.chat(chat, topic, seconds=0)
        except Failed:
            self.turn(self.f.message(chat, 'یادداشت برای این تاپیک', topic=topic, mention=False), chat, topic, expect_reply=False)
            return self.f.chat(chat, topic)

    def cards_since(self, before, chat):
        return [row for row in self.f.sent()[before:] if self.is_card(row) and row['message']['chat']['id'] == chat]

    def memory_writes(self, event_id, seconds=600):
        """What long-term memory (Honcho) holds of a message once every write of it is done, evidence about people and
        projects left aside: one {audience, session, writer, record} for each live write, sorted, and how many sessions they
        are in. The audience is the owner's or a chat's; the session is conversation or material (the owner's forwards and
        files); the writer is the message's own speaker, the forwards-and-files participant, the assistant, or another
        (ADR-0257)."""
        where = ("FROM memory_ingestion_receipts r JOIN memory_sessions s ON s.session_id=r.session_id WHERE r.source_reference->>'id'='"
                 + event_id+"' AND r.retired_at IS NULL AND r.record_kind<>'labelled_entity'")
        count = lambda condition='': self.f.query('nocheh_control', 'SELECT count(*) '+where+condition)
        self.wait('memory_written', lambda: count() != '0' and count(" AND r.state<>'done'") == '0', seconds)
        writer = ("CASE WHEN r.peer_id='nocheh_forwards_and_files' THEN 'forwards_and_files' WHEN r.peer_id='nocheh_assistant' THEN 'assistant' "
                  "WHEN r.peer_id='person_'||r.speaker_entity_id THEN 'speaker' ELSE 'other' END")
        raw = self.f.query('nocheh_control', "SELECT json_build_object('writes',json_agg(json_build_object('audience',CASE WHEN r.audience='owner' THEN 'owner' "
                           "ELSE 'chat' END,'session',s.kind,'writer',"+writer+",'record',r.record_kind) ORDER BY s.kind,"+writer+",r.record_kind),"
                           "'sessions',count(DISTINCT r.session_id)) "+where)
        return json.loads(raw)

    def turn(self, update, chat, topic=None, expect_reply=True, attempts=1, posted=None, chunked=False):
        """Inject one update and verify its single causal reply or its silence.

        Approval cards and a post the turn made right away (`posted`, exact
        text) are not the turn's reply; scenarios check those themselves.
        `chunked` lets a reply longer than Telegram's 4096 characters arrive
        as several messages in the same conversation, the first replying to
        the source; the text returned is the chunks joined."""
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
        new = [row for row in self.replies(before, chat, topic) if not self.is_card(row) and row['message'].get('text') != posted]
        if chunked:
            self.gate('reply_chunks_in_exact_conversation', bool(new) and all(len(row['message'].get('text') or '') <= 4096 for row in new),
                      count=len(new))
        else:
            self.gate('one_reply_in_exact_conversation', len(new) == 1, count=len(new))
        reply = json.loads(new[0]['parameters'].get('reply_parameters', '{}') or '{}')
        self.gate('reply_targets_source', reply.get('message_id') == update['message']['message_id'])
        for row in new if chunked else new[:1]:
            self.wait('delivery_archived', lambda row=row: archived_delivery(self.f.query, row['message'], update['update_id']), 60)
        self.replied.append((self.current['scenario'], event_id))
        # Joined without a separator, so a mark the split cut in two is still found whole.
        return event_id, ''.join(row['message']['text'] for row in new) if chunked else new[0]['message']['text']

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
        # Telegram service then reconnects polling; a reply ready in that window
        # was never transmitted and must be retried, then delivered once.
        started = time.time()
        self.f.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'model-fixture')
        wait_telegram_connected(self.wait, self.f.command, 'polling_connected')
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
        events = [event for event in self.f.agent() if event.get('directive') == 'long']
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
        phases = [event['phase'] for event in self.f.agent() if event.get('directive') == 'empty-once' and event.get('argument') == 'E1']
        self.gate('blank_answer_was_retried', phases[:2] == ['empty', 'final'], phases=phases, attempts=row['attempts'])
        self.gate('blank_answer_not_recorded_as_silence', row['state'] == 'done' and row['error'] is None)
        self.gate('recovered_answer_delivered', '[agent] recovered E1' in text)

    # Memory, tools and audience ---------------------------------------------

    def private_fact_and_search(self):
        fact = self.f.message(OWNER, 'یادت باشه: '+PRIVATE_FACT)
        self.state['fact'] = fact
        self.state['fact_event'], _ = self.turn(fact, OWNER)
        _, text = self.turn(self.f.message(OWNER, 'دنبالش بگرد [[search:PRIVFACT91]]'), OWNER)
        self.gate('archive_tool_called', any(event.get('tool') == 'mcp__nocheh__archive_search' and event['phase'] == 'final'
                                              and 'PRIVFACT91' in event.get('argument', '') for event in self.f.agent()))
        self.gate('owner_private_search_finds_fact', 'PRIVFACT91' in text and 'فیروزه' in text, excerpt=text[:300])

    def owner_private_context(self):
        _, text = self.turn(self.f.message(OWNER, 'چه می‌دانی؟ [[context:PRIVFACT91]]'), OWNER)
        self.gate('owner_private_context_has_fact', 'present' in text, answer=text)

    def group_cannot_see_private(self):
        _, text = self.turn(self.f.message(GROUP, 'دنبالش بگرد [[search:PRIVFACT91]]', topic=11), GROUP, 11)
        self.gate('group_search_withholds_private_fact', 'فیروزه' not in text and 'PRIVFACT91 ' not in text.replace('[[search:PRIVFACT91]]', ''),
                  excerpt=text[:300])
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__archive_search' and event['phase'] == 'final'][-1]
        self.gate('group_tool_result_withholds_fact', 'فیروزه' not in final['result'], result=final['result'][:300])
        _, text = self.turn(self.f.message(GROUP, 'چه می‌دانی؟ [[context:فیروزه]]', topic=11), GROUP, 11)
        events = [event for event in self.f.agent() if event.get('directive') == 'context']
        self.gate('group_model_context_withholds_fact', events[-1]['present'] is False, answer=text)
        _, text = self.turn(self.f.message(OTHER_GROUP, 'به خاطر داری؟ [[recall:رنگ مورد علاقه خواهر]]'), OTHER_GROUP)
        self.gate('other_group_recall_withholds_fact', 'فیروزه' not in text, excerpt=text[:300])

    def owner_recall(self):
        _, text = self.turn(self.f.message(OWNER, 'یادت هست؟ [[recall:رنگ مورد علاقه خواهر]]'), OWNER)
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__memory_recall' and event['phase'] == 'final'][-1]
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
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__archive_search' and event['phase'] == 'final'][-1]
        sources = json.loads(final['result'])['sources']
        self.gate('retired_source_not_retrieved', all(row['id'] != event_id for row in sources),
                  returned=[row['kind'] for row in sources])
        self.gate('offered_replies_not_retired_implicitly', all(not reply['retired'] for reply in
                  self.f.app('/v1/sources/'+event_id+'/retirement')['related_replies'] if reply['relation'] == 'quote'))
        for reply in quoting:
            self.f.app('/v1/sources/'+reply['event_id']+'/retirement', {'retired': True, 'expected_revision': reply['revision'],
                       'operation_id': 'scenario-retire-reply-'+reply['event_id'][:16]})
        _, again = self.turn(self.f.message(OWNER, 'یک بار دیگر [[search:PRIVFACT91]]'), OWNER)
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__archive_search' and event['phase'] == 'final'][-1]
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
        content = synthetic_pdf(['Synthetic invoice DOCMARK55', 'Total 420 credits'])
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
        extracted = self.f.query('nocheh_derived', "SELECT count(*) FROM derived_artifacts WHERE kind='extracted_text' AND event_id='"+event_id+"'"
                                 " AND position('DOCMARK55' in convert_from(content,'UTF8'))>0")
        self.gate('document_text_extracted', extracted == '1', count=extracted)
        self.own_file_split(event_id, 'document')

    def own_file_split(self, event_id, name):
        """The owner's own file in long-term memory: the caption stays the owner's own words, and the file's text goes
        beside it in the same chat, written by the forwards-and-files participant, never as the owner's words (ADR-0257)."""
        written = self.memory_writes(event_id)
        self.gate(name+'_caption_and_text_kept_apart', written['writes'] == [
            {'audience': 'owner', 'session': 'conversation', 'writer': 'forwards_and_files', 'record': 'labelled_material'},
            {'audience': 'owner', 'session': 'conversation', 'writer': 'speaker', 'record': 'labelled_source'}] and written['sessions'] == 1, written=written)

    # Approvals --------------------------------------------------------------

    def proposals(self):
        return self.f.app('/v1/tools/actions')['telegram']

    def action_approval(self):
        topic, wording = 17, 'سلام تیم، جلسه ساعت ۱۷ است ✅'
        # The destination is the topic's chat id, as the model gets it from the destinations list (ADR-0252).
        destination = self.topic_chat(GROUP, topic)
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        _, text = self.turn(self.f.message(OWNER, 'این پیام را به تاپیک تیم بفرست [[action:'+destination+'|'+wording+']]'), OWNER)
        created = [row for row in self.proposals() if row['id'] not in known]
        self.gate('one_proposal_created', len(created) == 1, count=len(created))
        self.gate('one_card_in_owner_chat', len(self.cards_since(before, OWNER)) == 1, count=len(self.cards_since(before, OWNER)))
        proposal = created[0]
        self.gate('proposal_exact', proposal['state'] == 'proposed' and proposal['arguments'] == {'destination': destination, 'text': wording},
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
        destination = self.topic_chat(GROUP, topic)
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        self.turn(self.f.message(OWNER, 'اینو بفرست [[action:'+destination+'|پیامی که نباید ارسال شود]]'), OWNER)
        proposal = [row for row in self.proposals() if row['id'] not in known][0]
        decision = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'deny'})
        self.gate('denied', decision['state'] == 'rejected')
        time.sleep(10)
        self.gate('denied_action_sends_nothing', not self.replies(before, GROUP, topic))

    def group_current_action(self):
        # The owner's post into the same group topic needs no approval (ADR-0165).
        topic, wording = 18, 'یادآوری گروهی'
        known = {row['id'] for row in self.proposals()}
        before = len(self.f.sent())
        self.turn(self.f.message(GROUP, 'اینجا بفرست [[action:current|'+wording+']]', topic=topic), GROUP, topic, posted=wording)
        created = [row for row in self.proposals() if row['id'] not in known]
        self.gate('group_action_created', len(created) == 1)
        self.gate('current_means_source_topic', created[0]['arguments']['destination'] == self.f.chat(GROUP, topic),
                  destination=created[0]['arguments']['destination'])
        self.wait('posted_right_away', lambda: [row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording], 180)
        time.sleep(5)
        self.gate('posted_once_without_card', len([row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording]) == 1
                  and not self.cards_since(before, OWNER) and not self.cards_since(before, GROUP))

    def schedule_fires_and_sends_without_card(self):
        # An owner-private schedule set by asking in the owner's chat fires on its own cadence, runs once, and its Telegram
        # result goes to the owner's private chat with no card: the owner approved that chat's schedules once (ADR-0266).
        # Nocheh records who set it from which message, and grants its fire (ADR-0290).
        known = {row['id'] for row in self.proposals()}
        started = self.f.query('nocheh_control', 'SELECT now()')
        before = len(self.f.sent())
        self.turn(self.f.message(OWNER, 'هر دقیقه یادم بنداز [[tool:cronjob_manage {"action":"create","name":"Synthetic reminder",'
                                 '"prompt":"یادآوری: آب بخور SCHEDMARK","schedule":"every 1m","repeat":1}]]'), OWNER)
        listed = lambda: self.f.app('/v1/agent/manage', {'action': 'schedules', 'operation': 'list'})['schedules']
        job = next((row for row in listed() if row['name'] == 'Synthetic reminder' and row.get('owner_chat')), None)
        self.gate('schedule_created', job is not None and job['deliver'] == 'telegram', job=job and job['id'])
        profile = job['profile']
        set_by = self.f.query('nocheh_control', "SELECT json_build_object('created_by',w.created_by,'via',v.set_by->>'via') FROM workflow_schedules w "
                              "JOIN schedule_versions v ON v.id=w.version_id WHERE w.logical_profile='"+profile+"' AND w.job_id='"+job['id']+"'")
        set_by = json.loads(set_by) if set_by else {}
        self.gate('schedule_set_by_asking', set_by == {'created_by': 'owner', 'via': 'turn'}, **set_by)
        notices = [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == OWNER
                   and any(str(button.get('callback_data') or '').startswith('nkd') for button in sent_buttons(row))]
        self.gate('schedule_notice_sent', len(notices) == 1, count=len(notices))
        refused = self.f.native('/api/cron/jobs?profile=default', {'name': 'Synthetic', 'prompt': 'x', 'schedule': 'every 1m'}, allow_error=True)
        self.gate('native_cron_read_only', refused['status'] == 403 and (refused['body'] or {}).get('error') == 'cron_read_only',
                  status=refused['status'])
        # The notice has Pause and Delete buttons, so it would count as a card: count only what comes after it.
        before = len(self.f.sent())
        run = self.wait('scheduled_run_done', lambda: self.f.query('nocheh_control', "SELECT json_build_object('id',event_id,'state',state,'error',error_code) "
            "FROM managed_runs WHERE channel='scheduler' AND created_at>='"+started+"' AND state IN ('done','failed','cancelled','interrupted')"), 300)
        run = json.loads(run)
        self.gate('scheduled_run_completed', run['state'] == 'done', state=run['state'], error=run['error'])
        result = self.wait('result_staged', lambda: next((row for row in self.proposals() if row['id'] not in known), None), 120)
        self.gate('result_addressed_to_owner_chat', result['arguments']['destination'] == self.f.chat(OWNER), destination=result['arguments']['destination'])
        self.wait('result_delivered', lambda: next(row for row in self.proposals() if row['id'] == result['id'])['state'] in ('done', 'ambiguous'), 240)
        final = next(row for row in self.proposals() if row['id'] == result['id'])
        self.gate('result_sent_without_approval', final['state'] == 'done', state=final['state'], error=final.get('error_code'))
        time.sleep(5)
        new = self.replies(before, OWNER)
        self.gate('no_card_for_owner_schedule', not self.cards_since(before, OWNER), cards=len(self.cards_since(before, OWNER)))
        self.gate('delivered_once_with_exact_text', len(new) == 1 and new[0]['message']['text'] == result['arguments']['text'], count=len(new))
        time.sleep(75)
        runs = self.f.query('nocheh_control', "SELECT count(*) FROM managed_runs WHERE channel='scheduler' AND created_at>='"+started+"'")
        self.gate('repeat_limit_honored', runs == '1', runs=runs)
        # The owner removes a schedule that has finished its runs through Nocheh, which grants the removal.
        removed = self.f.app('/v1/agent/manage', {'action': 'schedules', 'operation': 'delete', 'profile': profile, 'job_id': job['id'],
                                                  'request_id': 'scenario-delete-'+job['id']})
        self.gate('finished_schedule_removed', removed == {'ok': True} and all(row['id'] != job['id'] for row in listed()))

    # Members ------------------------------------------------------------------

    # Every permission on and the member active: what Add by Telegram user ID gives a member, their private chat with
    # Nocheh included (step 4).
    MEMBER_DEFAULTS = {'state': 'active', 'talk': True, 'jobs': True, 'post': True, 'tools': True, 'tasks': 'write', 'private_chat': True}

    def members_api(self, path='', body=None, allow_error=False, signed_in=False):
        """The owner's Members routes (GET /v1/members; POST /v1/members, /settings, /<id> and /<id>/remove) as the
        dashboard calls them: through its own proxy, /api/nocheh/members..., signed in like the browser. A fixture without
        the preview relay (started without --preview-port) is asked on the owner API directly. A change takes effect at
        once, with no restart. `allow_error` returns {status, body} instead of failing on an error."""
        if getattr(self, 'members_session', None) is None:
            from tools.acceptance.owner_dashboard import Dashboard, preview_port
            try:
                port = preview_port(self.f.manifest)
            except ValueError:
                port = None
            self.members_session = Dashboard(self.f, port) if port else False
        if not self.members_session:
            return self.f.app('/v1/members'+path, body, allow_error=allow_error)
        result = self.members_session.call('GET' if body is None else 'POST', '/members'+path, body, allow_error=True)
        if result['status'] == 401 and not signed_in:
            # The browser session is gone, as after the dashboard service restarted: sign in again, once.
            self.members_session = None
            return self.members_api(path, body, allow_error, signed_in=True)
        if result['status'] >= 400 and not allow_error:
            raise Failed('members_http_'+str(result['status'])+':'+(path or '/')+':'+json.dumps(result['body'])[:300])
        return result if allow_error else result['body']

    def fresh_person(self):
        """A Telegram user id no earlier scenario used, for someone whose once-a-day replies must start fresh."""
        return 5000000+self.f.ids()%1000000

    @staticmethod
    def operation_id(kind):
        return 'tester-'+kind+'-'+str(time.time_ns())

    def member_item(self, person, listing=None):
        """The member whose account is the Telegram user `person`, as the owner's Members list shows them, or None."""
        listing = listing or self.members_api()
        return next((item for item in listing['members'] if item.get('telegram_id') == str(person)), None)

    def member_switches(self, groups, listing):
        """A member's group switches as Add by Telegram user ID sends them: the Telegram groups in `groups` ticked, every
        other group Nocheh is in unticked."""
        ticked = {self.f.chat(group) for group in groups}
        return {**{row['chat_id']: row['chat_id'] in ticked for row in listing['groups']}, **{chat: True for chat in ticked}}

    def add_member(self, person, groups, listing=None):
        """The owner makes the Telegram user `person` a member by their Telegram user ID, with `groups` (Telegram group
        ids) ticked, every other group Nocheh is in unticked and every permission on. Someone already a member, as on a
        kept fixture, is set the same way. Returns the member as the list shows them."""
        listing = listing or self.members_api()
        switches, item = self.member_switches(groups, listing), self.member_item(person, listing)
        if item is None:
            return self.members_api('', {'operation_id': self.operation_id('member-add'), 'telegram_id': str(person), 'groups': switches})['member']
        return self.change_member_switches(item, switches, self.MEMBER_DEFAULTS)

    def set_members(self, wanted):
        """Members as the owner sets them on the Members page: {Telegram user id: Telegram group ids ticked}."""
        listing = self.members_api()
        return {person: self.add_member(person, groups, listing) for person, groups in wanted.items()}

    def change_member_switches(self, item, switches, changes):
        """Send the owner's change of a member, only what differs from the list's `item`: `switches` by Nocheh chat id, and
        state and permissions (talk, jobs, post, tools, tasks, private_chat). A group with no switch counts as on, so turning one on that
        is already on sends nothing, and a new switch is only ever an off one. Returns the member as the list shows them."""
        current = {row['chat_id']: row['on'] for row in item['groups']}
        held = {**item['permissions'], 'state': item['state']}
        body = {key: value for key, value in changes.items() if held.get(key) != value}
        groups = {chat: on for chat, on in switches.items() if current.get(chat, True) != on}
        if groups:
            body['groups'] = groups
        if not body:
            return item
        return self.members_api('/'+item['id'], {'operation_id': self.operation_id('member-change'), 'changes': body})['member']

    def change_member(self, item, groups=None, **changes):
        """The owner's change of a member: `groups` maps Telegram group ids to on or off; `changes` are state='paused' or
        'active', talk, jobs, post, tools and private_chat (True or False) and tasks ('write' or 'read')."""
        return self.change_member_switches(item, {self.f.chat(group): on for group, on in (groups or {}).items()}, changes)

    def remove_member(self, item):
        """The owner removes a member; one already removed is left as it is."""
        result = self.members_api('/'+item['id']+'/remove', {'operation_id': self.operation_id('member-remove')}, allow_error=True)
        if result['status'] not in (200, 404):
            raise Failed('member_not_removed:'+str(result['status'])+':'+json.dumps(result['body'])[:300])

    def seen_in(self, person, groups):
        """Make sure Telegram has shown the member `person` in each of `groups`, as the owner's Members list says it. What is
        decided without a message from a group, such as a post into it from another group, a job's run or a send to the
        member's private chat, needs it there. A group where the list does not say 'in' gets a message from them there that
        addresses nobody."""
        for group in groups:
            chat = self.f.chat(group)
            if self.member_presence(person, chat) != 'in':
                self.turn(self.f.message(group, 'سلام به همه', sender=person, mention=False), group, expect_reply=False)
                self.wait('telegram_shows_member_in_group', lambda: self.member_presence(person, chat) == 'in', 60)

    def member_presence(self, person, chat):
        """What Telegram last said of the member `person` in a group (a Nocheh chat id), as the owner's Members list shows
        it: 'in', 'left' or None."""
        return next((row['telegram'] for row in (self.member_item(person) or {}).get('groups', []) if row['chat_id'] == chat), None)

    def service_starts(self):
        """When each running service of the fixture last started, by service name."""
        ids = subprocess.check_output(self.f.command+['ps', '-q'], text=True).split()
        lines = subprocess.check_output(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}} {{.State.StartedAt}}',
                                         *ids], text=True).splitlines() if ids else []
        return dict(line.split(' ', 1) for line in lines if ' ' in line)

    def nothing_restarted(self, before):
        """A member change needs no restart: every service that ran before still runs since the same start."""
        after = self.service_starts()
        restarted = sorted(name for name, started in before.items() if after.get(name) != started)
        self.gate('no_service_restarted', bool(before) and not restarted, restarted=restarted)

    # Audience policy ----------------------------------------------------------

    def not_allowed_reply(self, update, topic, chat=GROUP):
        """Someone who may not use Nocheh in the group addresses it: no model turn, one fixed reply under their message."""
        before = len(self.f.sent())
        self.f.inject(update)
        row = self.finished(self.captured(update))
        self.gate('no_model_turn', row['state'] in ('suppressed', 'cancelled'), state=row['state'], error=row['error'])
        new = self.wait('fixed_reply', lambda: self.replies(before, chat, topic), 120)
        time.sleep(3)
        new = self.replies(before, chat, topic)
        target = json.loads(new[0]['parameters'].get('reply_parameters', '{}') or '{}').get('message_id')
        self.gate('one_fixed_reply_to_the_message', len(new) == 1 and new[0]['message']['text'] == NOT_ALLOWED
                  and target == update['message']['message_id'], count=len(new), text=new[0]['message']['text'])

    def refused_quietly(self, update, chat, topic=None):
        """Someone already refused in the group today addresses Nocheh again: no model turn and no second fixed reply, as
        the reply comes at most once a UTC day per person and group."""
        before = len(self.f.sent())
        self.turn(update, chat, topic, expect_reply=False)
        time.sleep(3)
        self.gate('no_second_fixed_reply_that_day', not [row for row in self.replies(before, chat, topic) if row['message'].get('text') == NOT_ALLOWED])

    def participant_not_permitted(self):
        # A stranger who addresses Nocheh in a group gets the fixed reply once; the same day a second message gets nothing.
        # A person new to the fixture, since everyone gets the reply at most once a UTC day per group.
        stranger = self.fresh_person()
        self.not_allowed_reply(self.f.message(GROUP, 'سلام ربات', sender=stranger, topic=16), 16)
        self.refused_quietly(self.f.message(GROUP, 'سلام دوباره، کسی هست؟', sender=stranger, topic=16), GROUP, 16)

    def leave_calls(self, chat):
        """Every leaveChat the Telegram service made for a chat, refused ones included."""
        return [call for call in self.f.telegram()['calls'] if call['method'] == 'leaveChat' and str(call['parameters'].get('chat_id')) == str(chat)]

    def add_records(self, chat):
        """How many content-free records of Nocheh being added to or removed from a chat there are (ADR-0253)."""
        return int(self.f.query('nocheh_control', "SELECT count(*) FROM chat_state_events e JOIN chat_ids i ON i.chat_id=e.chat_id "
                                "WHERE i.external_id='"+str(int(chat))+"'"))

    def unselected_group(self):
        # A group Nocheh is in that nobody added it to while it watched (ADR-0253): it is Off, so a message there gets no
        # reply and no refusal, Nocheh never leaves it on its own and the owner hears nothing. The owner's chat list shows it
        # Off, where they can turn Nocheh on.
        before = len(self.f.sent())
        self.turn(self.f.message(UNSELECTED_GROUP, 'سلام'), UNSELECTED_GROUP, expect_reply=False)
        item = self.f.chat_item(UNSELECTED_GROUP)
        self.gate('listed_off', item.get('kind') == 'group' and item.get('state') == 'off', state=item.get('state'))
        self.gate('no_add_recorded', self.add_records(UNSELECTED_GROUP) == 0)
        self.gate('never_left', not self.leave_calls(UNSELECTED_GROUP))
        self.gate('nothing_sent_there_or_about_it', not [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == UNSELECTED_GROUP
                                                        or 'Synthetic Forum '+str(UNSELECTED_GROUP) in (row['message'].get('text') or '')])

    def group_answers_only_when_addressed(self):
        # A question to the whole group gets no reply; the bot's name opening a
        # message, and a reply to the bot's own message, address it.
        event_id, _ = self.turn(self.f.message(GROUP, 'کسی برای ناهار می‌آید؟', mention=False), GROUP, None, expect_reply=False)
        self.gate('unaddressed_message_not_addressed', self.f.dispatch(event_id)['error'] == 'not_addressed')
        self.turn(self.f.message(GROUP, 'Synthetic، نظرت درباره‌ی ناهار چیست؟', mention=False), GROUP, None)
        answer = self.f.sent()[-1]['message']
        self.turn(self.f.message(GROUP, 'یک پیشنهاد دیگر بده', mention=False, reply_to=answer), GROUP, None)

    def general_after_topics(self):
        self.turn(self.f.message(GROUP, 'سلام در تاپیک عمومی'), GROUP, None)

    # Telegram failures ----------------------------------------------------------

    def deleted_topic(self):
        topic = 19
        before = len(self.f.sent())
        # The sender retries a one-off "thread not found" once, so a topic that is really gone refuses both sends.
        gone = {'method': 'sendMessage', 'code': 400, 'description': 'Bad Request: message thread not found'}
        self.f.control({'faults': [gone, dict(gone)]})
        update = self.f.message(GROUP, 'تاپیکی که حذف می‌شود', topic=topic)
        self.f.inject(update)
        row = self.finished(self.captured(update), seconds=400)
        stray = [row for row in self.f.sent()[before:] if row['message']['chat']['id'] == GROUP and row['message'].get('message_thread_id') != topic]
        self.gate('no_fallback_to_general_or_other_topic', not stray, stray=len(stray))
        calls = [call for call in self.f.telegram()['calls'] if call['method'] == 'sendMessage' and call['parameters'].get('message_thread_id') is not None
                 and int(call['parameters']['message_thread_id']) == topic]
        self.gate('every_attempt_kept_topic', bool(calls) and all(int(call['parameters']['chat_id']) == GROUP for call in calls), attempts=len(calls))
        left = [fault for fault in self.f.telegram()['faults'] if fault['method'] == 'sendMessage']
        self.gate('no_refusal_left_for_later_sends', not left, left=len(left))
        self.gate('rejected_by_telegram', row['state'] == 'suppressed' and row['error'] == 'telegram_rejected', state=row['state'], error=row['error'])

    def polling_outage(self):
        self.f.control({'faults': [{'method': 'getUpdates', 'code': 502, 'description': 'Bad Gateway'},
                                   {'method': 'getUpdates', 'code': 500, 'description': 'Internal Server Error'}]})
        self.wait('polling_faults_consumed', lambda: not [fault for fault in self.f.telegram()['faults'] if fault['method'] == 'getUpdates'], 120)
        # The Telegram service restarts polling after the faults. A reply ready before that
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

    def voice(self, content, sender=OWNER, chat=OWNER, topic=None, duration=2, mime_type='audio/ogg', extension='.oga'):
        file_id = 'voice-'+str(self.f.ids())
        self.f.control({'files': [{'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_path': 'documents/'+file_id+extension,
                                   'file_size': len(content), 'bytes_base64': base64.b64encode(content).decode()}]})
        update = self.f.message(chat, None, sender=sender, topic=topic, extra={'voice': {'file_id': file_id, 'file_unique_id': 'u'+file_id,
                                'duration': duration, 'mime_type': mime_type, 'file_size': len(content)}})
        self.f.inject(update)
        event_id = self.captured(update)
        expected = hashlib.sha256(content).hexdigest()
        self.wait('voice_bytes_archived', lambda: self.f.query('nocheh_archive', "SELECT file_hash FROM artifacts WHERE event_id='"+event_id+"'") == expected, 120)
        self.gate('voice_bytes_unchanged', (self.f.directory/'state/files'/expected).read_bytes() == content)
        return update, event_id

    def voice_is_transcribed(self):
        # A voice note keeps its original bytes, is transcribed by Hermes's
        # transcriber through the Voice notes route, and its reply waits for it.
        # A real recording: the file reader decodes it before it is transcribed (ADR-0285).
        _, event_id = self.voice(synthetic_wav(2))
        row = self.finished(event_id, seconds=300)
        self.gate('voice_dispatch_closed', row['state'] in ('done', 'suppressed'), state=row['state'], error=row['error'])
        transcript = self.f.query('nocheh_derived', "SELECT count(*) FROM derived_artifacts WHERE kind='transcript' AND event_id='"+event_id+"'"
                                  " AND position('VOICEMARK77' in convert_from(content,'UTF8'))>0")
        self.gate('voice_transcribed', transcript == '1', count=transcript)
        # The owner's own voice is the owner's own words in long-term memory (ADR-0257).
        written = self.memory_writes(event_id)
        self.gate('own_voice_stays_the_owners_words', written['writes'] == [{'audience': 'owner', 'session': 'conversation', 'writer': 'speaker', 'record': 'labelled_source'}],
                  written=written)
        started = time.monotonic()
        self.turn(self.f.message(OWNER, 'یک پیام متنی بعد از ویس'), OWNER)
        self.gate('next_message_not_held', time.monotonic()-started < 90, seconds=round(time.monotonic()-started, 1))

    def transcript(self, event_id):
        return self.f.query('nocheh_derived', "SELECT convert_from(content,'UTF8') FROM derived_artifacts WHERE kind='transcript' AND event_id='"
                            + event_id+"' ORDER BY created_at DESC LIMIT 1")

    def transcribed_seconds(self):
        """The seconds of audio sent to the Voice notes model over the last two days, as the owner's Usage page counts them."""
        raw = subprocess.run(self.f.command+['exec', '-T', 'nocheh-dashboard', 'python3', '-m', 'tools.runtime.management'],
                             input=json.dumps({'operation': 'usage.view', 'days': 2}), text=True, capture_output=True, timeout=180)
        found = json.loads(raw.stdout.strip().splitlines()[-1]) if raw.stdout.strip() else {}
        rows = (found.get('result') or {}).get('rows')
        if not isinstance(rows, list):
            raise Failed('usage_unreadable:'+str(found.get('error')))
        return sum(row.get('audio_seconds') or 0 for row in rows if row.get('part') == 'transcription')

    def long_voice_is_read_whole_from_everyone(self):
        # A long recording from someone the owner has not allowed in a group is transcribed whole, as everything in a
        # group is read from everyone (ADR-0264); Telegram's stated length changes nothing.
        content = synthetic_wav(16*60)
        before = self.transcribed_seconds()
        _, event_id = self.voice(content, sender=PARTICIPANT, chat=GROUP, topic=27, duration=5, mime_type='audio/wav', extension='.wav')
        self.finished(event_id, seconds=600)
        text = self.wait('stranger_voice_transcribed', lambda: self.transcript(event_id), 600, 5)
        self.gate('stranger_voice_whole', 'VOICEMARK77' in text and OLD_FIRST_PART not in text, end=text[-120:])
        spent = self.transcribed_seconds()-before
        self.gate('stranger_recording_sent_whole', spent >= 959, seconds=spent)

    def photo_is_read(self):
        # A photo keeps its original bytes and is read once, at its largest size, by Hermes's vision tool with the
        # Images model before its reply. Telegram's smaller sizes stay listed in the update, never fetched or read.
        sizes = [(synthetic_png(4), 32, 24), (synthetic_png(16), 128, 96), (synthetic_png(8), 64, 48)]
        files = [('photo-'+str(self.f.ids()), content, width, height) for content, width, height in sizes]
        self.f.control({'files': [{'file_id': file_id, 'file_unique_id': 'u'+file_id, 'file_path': 'documents/'+file_id+'.png',
                                   'file_size': len(content), 'bytes_base64': base64.b64encode(content).decode()}
                                  for file_id, content, _, _ in files]})
        update = self.f.message(OWNER, None, extra={'caption': 'این تابلو را نگه دار', 'photo': [
            {'file_id': file_id, 'file_unique_id': 'u'+file_id, 'width': width, 'height': height, 'file_size': len(content)}
            for file_id, content, width, height in files]})
        event_id, _ = self.turn(update, OWNER)
        largest, content = files[1][0], files[1][1]
        expected = hashlib.sha256(content).hexdigest()
        self.wait('photo_bytes_archived', lambda: self.f.query('nocheh_archive', "SELECT file_hash FROM artifacts WHERE event_id='"+event_id+"'") == expected, 120)
        kept = self.f.query('nocheh_archive', "SELECT string_agg(source_ref,',') FROM artifacts WHERE event_id='"+event_id+"'")
        self.gate('photo_kept_once_at_its_largest_size', kept == largest, kept=kept)
        read = self.f.query('nocheh_derived', "SELECT count(*) FROM derived_artifacts WHERE kind='extracted_text' AND event_id='"+event_id+"'"
                            " AND position('SIGNMARK88' in convert_from(content,'UTF8'))>0")
        self.gate('photo_text_read_once', read == '1', count=read)
        listed = self.f.query('nocheh_archive', "SELECT jsonb_array_length(convert_from(payload,'UTF8')::jsonb->'message'->'photo') FROM events WHERE id='"
                              + event_id+"'")
        self.gate('every_size_stays_in_the_update', listed == '3', sizes=listed)
        # What the photo was read to say is a file's text, kept apart from its caption.
        self.own_file_split(event_id, 'photo')

    # Locked-down Hermes (ADR-0251) ---------------------------------------------------

    def hermes_exec(self, *command):
        result = subprocess.run(self.f.command+['exec', '-T', 'hermes', *command], capture_output=True, text=True, timeout=120)
        return result.stdout if result.returncode == 0 else ''

    def hermes_is_locked_down(self):
        # Hermes runs read-only without capabilities, writes only its mounted folders and a memory /tmp, and sees
        # neither the dashboard's token nor the rest of the spool.
        container = subprocess.check_output(self.f.command+['ps', '-q', 'hermes'], text=True).strip()
        found = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
        host, mounts = found['HostConfig'], {mount['Destination']: mount for mount in found['Mounts']}
        environment = dict(item.split('=', 1) for item in found['Config']['Env'] if '=' in item)
        self.gate('read_only_root', host.get('ReadonlyRootfs') is True)
        self.gate('no_capabilities', 'ALL' in [name.upper() for name in host.get('CapDrop') or []] and not host.get('CapAdd'),
                  dropped=host.get('CapDrop'), added=host.get('CapAdd'))
        self.gate('no_new_privileges', any(option.startswith('no-new-privileges') and not option.endswith('false')
                                           for option in host.get('SecurityOpt') or []), options=host.get('SecurityOpt'))
        self.gate('memory_tmp', '/tmp' in (host.get('Tmpfs') or {}) or mounts.get('/tmp', {}).get('Type') == 'tmpfs', tmpfs=host.get('Tmpfs'))
        self.gate('memory_home', environment.get('HOME') == '/tmp/home',
                  home=environment.get('HOME'))
        # The agent login, never Nocheh's master key (ADR-0295), and it reaches only the agent's own routes.
        self.gate('no_master_key', 'SERVICE_TOKEN' not in environment and 'SERVICE_TOKEN_FILE' not in environment)
        self.gate('agent_login_present', bool(environment.get('AGENT_KEY')))
        script = """const answers=[];for(const [method,path] of [['GET','/v1/status'],['POST','/v1/agent/manage']]){
const response=await fetch('http://nocheh-app:8780'+path,{method,headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.AGENT_KEY},
...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(30000)});const text=await response.text();
let error=null;try{error=JSON.parse(text).error}catch{}answers.push({path,status:response.status,error});}
console.log(JSON.stringify(answers));"""
        answers = json.loads(subprocess.check_output(self.f.command+['exec', '-T', 'nocheh-app', 'node', '--input-type=module', '-e', script],
                                                     text=True).strip().splitlines()[-1])
        self.gate('agent_login_refused_elsewhere', all(row['status'] == 403 and row['error'] == 'agent_route_not_allowed' for row in answers),
                  answers=answers)
        self.gate('only_the_folders_it_uses', {'/dashboard-state/home', '/data/spool/agent-turns'} <= set(mounts)
                  and not {'/dashboard-state', '/data/spool'} & set(mounts), mounts=sorted(mounts))
        probe = ('token=absent; [ -e /dashboard-state/token ] && token=present; '
                 'write() { if ( : > "$1/.nocheh-write-probe" ) 2>/dev/null; then rm -f "$1/.nocheh-write-probe"; echo written; else echo refused; fi; }; '
                 'home=missing; [ -d "$HOME" ] && home=present; '
                 'printf \'{"token":"%s","spool":"%s","image":"%s","tmp":"%s","home":"%s"}\\n\' '
                 '"$token" "$(write /data/spool)" "$(write /workspace)" "$(write /tmp)" "$home"')
        output = self.hermes_exec('sh', '-c', probe).strip()
        probed = json.loads(output.splitlines()[-1]) if output else {}
        self.current['observed'] = probed
        self.gate('dashboard_token_not_seen', probed.get('token') == 'absent', **probed)
        self.gate('spool_root_and_image_refuse_writes', probed.get('spool') == 'refused' and probed.get('image') == 'refused')
        self.gate('tmp_and_home_writable', probed.get('tmp') == 'written' and probed.get('home') == 'present')

    def files_upload_over_1mb(self):
        # The Files page's upload over 1 MB is spooled through /tmp, now memory: it is kept whole in the profile's
        # workspace, listed, downloaded unchanged and deleted.
        # Hermes's own file routes accept only its bound address as Host, as the dashboard's proxy sends it.
        script = """import crypto from 'node:crypto';import http from 'node:http';
const folder='nocheh-tester-'+process.argv[1],name='large-upload.bin',file=folder+'/'+name;
const call=(path,{method='GET',body=null,headers={}}={})=>new Promise((resolve,reject)=>{
const request=http.request({host:'hermes',port:8785,path,method,timeout:120000,headers:{host:'127.0.0.1:8785',
'X-Hermes-Session-Token':process.env.NOCHEH_HERMES_SESSION_TOKEN,...headers,...(body?{'content-length':body.length}:{})}},response=>{
const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const data=Buffer.concat(chunks);
response.statusCode>=400?reject(Error('native_http_'+response.statusCode+':'+data.toString().slice(0,300))):resolve(data);});});
request.on('timeout',()=>request.destroy(Error('native_timeout')));request.on('error',reject);if(body)request.write(body);request.end();});
const content=crypto.randomBytes(1536*1024),form=new FormData();
form.append('file',new Blob([content]),name);form.append('path',file);form.append('overwrite','true');
const encoded=new Request('http://upload.invalid/',{method:'POST',body:form});
await call('/api/files/upload-stream?profile=default',{method:'POST',body:Buffer.from(await encoded.arrayBuffer()),
headers:{'content-type':encoded.headers.get('content-type')}});
const listed=JSON.parse(await call('/api/files?profile=default&path='+encodeURIComponent(folder)));
const downloaded=await call('/api/files/download?profile=default&path='+encodeURIComponent(file));
await call('/api/files?profile=default',{method:'DELETE',headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({path:folder,recursive:true}))});
const after=JSON.parse(await call('/api/files?profile=default'));
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({bytes:content.length,sent:digest(content),received:digest(downloaded),
listed:listed.entries.filter(entry=>entry.name===name).map(entry=>entry.size),left:after.entries.some(entry=>entry.name===folder)}));"""
        named, env = self.f.session()
        found = json.loads(subprocess.check_output(self.f.command+['exec', '-T', *named, 'nocheh-app', 'node', '--input-type=module', '-e', script,
                                                                  str(self.f.ids())], text=True, env=env).strip().splitlines()[-1])
        self.current['observed'] = {'bytes': found['bytes']}
        self.gate('uploaded_whole', found['listed'] == [found['bytes']], listed=found['listed'])
        self.gate('downloaded_unchanged', found['sent'] == found['received'])
        self.gate('upload_deleted', not found['left'])

    def profiles_round_trip(self):
        # Hermes's Profiles page lists profiles and refuses changes (ADR-0295, the owner's pending answer): the agent
        # login cannot save a profile in Nocheh.
        before = self.f.native('/api/profiles')['profiles']
        default = next((row['name'] for row in before if row.get('is_default')), None)
        self.gate('profiles_listed', default is not None, names=[row['name'] for row in before])
        created = self.f.native('/api/profiles', {'name': 'tester-'+str(self.f.ids())}, allow_error=True)
        self.gate('profile_create_refused', created['status'] == 403 and (created['body'] or {}).get('error') == 'profiles_read_only',
                  status=created['status'])
        retired = self.f.native('/api/profiles/'+str(default), {}, 'DELETE', allow_error=True)
        self.gate('profile_retire_refused', retired['status'] == 403 and (retired['body'] or {}).get('error') == 'profiles_read_only',
                  status=retired['status'])
        after = self.f.native('/api/profiles')['profiles']
        self.gate('profiles_unchanged', [(row['name'], row.get('state')) for row in after] == [(row['name'], row.get('state')) for row in before])

    def no_refused_writes(self):
        # After the document, photo and voice scenarios, no file failed to be read for want of room in /tmp or a
        # refused write. HOME is emptied at each restart, so what it holds is listed to show it holds only caches.
        script = ('import json,sqlite3\n'
                  "db=sqlite3.connect('/workspace/data/local/hermes/usage/usage.sqlite')\n"
                  'try:rows=db.execute("SELECT day,reader,done,temp_full,read_only FROM reader_daily").fetchall()\n'
                  'except sqlite3.OperationalError:rows=[]\n'
                  'print(json.dumps(rows))')
        output = self.hermes_exec('python', '-c', script).strip()
        self.gate('reader_counts_read', bool(output))
        rows = json.loads(output.splitlines()[-1])
        listed = self.hermes_exec('find', '/tmp/home', '-maxdepth', '3')
        (self.report/'hermes-home.txt').write_text(listed)
        self.current['observed'] = {'reads': rows, 'home_entries': len(listed.splitlines())}
        self.gate('no_reader_write_failures', not [row for row in rows if row[3] or row[4]], rows=rows)

    # Owner authority ------------------------------------------------------------

    def owner_directory_lists_conversations(self):
        topic, name = 31, 'برنامه‌ریزی تیم'
        root = {'message_id': topic, 'date': 1, 'chat': {'id': GROUP, 'type': 'supergroup', 'is_forum': True}, 'forum_topic_created': {'name': name, 'icon_color': 7322096}}
        self.turn(self.f.message(GROUP, 'سلام از تاپیک برنامه‌ریزی', topic=topic, reply_to=root), GROUP, topic)
        _, text = self.turn(self.f.message(OWNER, 'گروه‌ها و تاپیک‌هایم را فهرست کن [[owner:conversations]]'), OWNER)
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__owner_read' and event['phase'] == 'final'][-1]
        items = json.loads(final['result'])['items']
        named = {item['space_id']: item['name'] for item in items}
        self.gate('owner_sees_groups', self.f.chat(GROUP) in named and self.f.chat(OTHER_GROUP) in named,
                  groups=sorted(item['space_id'] for item in items if item.get('kind') == 'group'))
        self.gate('topic_named_from_root_message', named.get(self.f.chat(GROUP, topic)) == name, name=named.get(self.f.chat(GROUP, topic)))
        self.turn(self.f.message(GROUP, 'فهرست گروه‌ها [[owner:conversations]]', topic=11), GROUP, 11)
        final = [event for event in self.f.agent() if event.get('tool') == 'mcp__nocheh__owner_read' and event['phase'] == 'final'][-1]
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
        broken_row = self.finished(self.captured(broken))
        self.current['broken_original'] = {'state': broken_row['state'], 'error': broken_row['error'], 'replies': len(self.replies(before, GROUP, 32))}
        self.gate('broken_original_answered_at_most_once', len(self.replies(before, GROUP, 32)) <= 1)
        health = telegram_health(self.f.command)
        self.gate('unparseable_update_visible', (health.get('telegram_details') or {}).get('unparseable_updates', 0) >= 1, health=health.get('telegram_details'))

    def telegram_refresh_names(self):
        # A refresh that finds a group upgraded now moves the chat onto its new Telegram id (ADR-0252); later scenarios
        # still post in OTHER_GROUP by its id, so a refresh that finds an upgrade is checked on a group no other scenario
        # posts in, in product_scenarios.supergroup_upgrade_keeps_history.
        self.f.control({'chats': [{'id': GROUP, 'type': 'supergroup', 'title': 'Synthetic Forum Refreshed', 'is_forum': True},
                                  {'id': OTHER_GROUP, 'type': 'supergroup', 'title': 'Synthetic Forum '+str(OTHER_GROUP), 'is_forum': True}]})
        before = len(self.f.sent())
        result = self.f.app('/v1/telegram/chats/refresh', {})
        states = {chat['chat_id']: chat for chat in result['chats']}
        refreshed = lambda chat: next((row for row in states.values() if row.get('external') == str(chat)), states.get(self.f.chat(chat)) or states.get(str(chat)))
        group = refreshed(GROUP) or {}
        self.gate('refresh_reads_telegram', group.get('state') == 'available' and group.get('title') == 'Synthetic Forum Refreshed', group=group)
        self.gate('refresh_sends_nothing', len(self.f.sent()) == before)

    def owner_freedom_keeps_group_cards(self):
        # The freedom setting covers only the owner's private side: a post the owner asks for in their private chat for a
        # group or topic still shows its card there first, naming the group and showing the exact text (ADR-0244).
        topic, wording, note = 17, 'پیام گروه فقط با کارت مالک', 'یادداشت برای خودم بدون کارت'
        destination, own = self.topic_chat(GROUP, topic), self.f.chat(OWNER)
        current = self.f.app('/v1/owner-autonomy')
        self.gate('approval_required_by_default', current['mode'] == 'approval_required')
        enabled = self.f.app('/v1/owner-autonomy', {'mode': 'owner_requests_execute', 'expected_revision': current['revision'],
                                                    'operation_id': 'scenario-freedom-'+str(self.f.ids())})
        try:
            known = {row['id'] for row in self.proposals()}
            before = len(self.f.sent())
            self.turn(self.f.message(OWNER, 'بفرست [[action:'+destination+'|'+wording+']]'), OWNER)
            created = [row for row in self.proposals() if row['id'] not in known]
            self.gate('group_post_waits_with_setting_on', len(created) == 1 and created[0]['state'] == 'proposed',
                      state=created[0]['state'] if created else None)
            cards = self.cards_since(before, OWNER)
            text = cards[0]['message']['text'] if cards else ''
            self.gate('one_card_names_the_group', len(cards) == 1 and 'Synthetic Forum' in text and wording in text, count=len(cards), card=text)
            time.sleep(5)
            self.gate('nothing_in_group_before_approve', not self.replies(before, GROUP, topic))
            proposal = created[0]
            decision = self.f.app('/v1/tools/telegram-decision', {'id': proposal['id'], 'fingerprint': proposal['fingerprint'], 'decision': 'approve',
                                                                  'operation_id': 'scenario-freedom-approve-'+proposal['id'][:16]})
            self.gate('approved', decision['state'] == 'approved')
            self.wait('sent_after_approve', lambda: [row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording], 180)
            self.gate('sent_once', len([row for row in self.replies(before, GROUP, topic) if row['message']['text'] == wording]) == 1)
            # A message to the owner's own private chat still goes without a card.
            known = {row['id'] for row in self.proposals()}
            mark = len(self.f.sent())
            self.turn(self.f.message(OWNER, 'یادداشت کن [[action:'+own+'|'+note+']]'), OWNER, posted=note)
            created = [row for row in self.proposals() if row['id'] not in known]
            self.gate('own_chat_approved_by_setting', len(created) == 1 and created[0]['state'] in ('approved', 'running', 'done'),
                      state=created[0]['state'] if created else None)
            self.wait('own_chat_sent_without_decision', lambda: [row for row in self.replies(mark, OWNER) if row['message']['text'] == note], 180)
            self.gate('no_card_for_own_chat', not self.cards_since(mark, OWNER))
            # Group-to-group cards with this setting off are product_scenarios.owner_from_group_to_other_group.
        finally:
            self.f.app('/v1/owner-autonomy', {'mode': 'approval_required', 'expected_revision': enabled['revision'],
                                              'operation_id': 'scenario-freedom-reset-'+str(self.f.ids())})

    def launcher_stop_mid_turn(self):
        before = len(self.f.sent())
        update = self.f.message(OWNER, 'یک جواب طولانی‌تر [[long:3000]]')
        self.f.inject(update)
        event_id = self.captured(update)
        listed = lambda: isolated_turns('-q').split()
        self.wait('turn_container_running', listed, 120, 1)
        self.f.run('stop', '-t', '30', 'hermes-agent-sb')
        time.sleep(3)
        self.gate('no_turn_container_left', not isolated_turns('-aq').split())
        self.f.run('up', '-d', '--no-build', '--no-deps', '--wait', 'hermes-agent-sb')
        row = self.finished(event_id, seconds=400)
        self.gate('interrupted_turn_recovered', row['state'] == 'done', state=row['state'], attempts=row['attempts'])
        self.gate('one_reply_after_recovery', len(self.replies(before, OWNER)) >= 1 and
                  len({json.loads(r['parameters'].get('reply_parameters', '{}')).get('message_id') for r in self.replies(before, OWNER)}) == 1)

    def sends_quiet(self, seconds=15, limit=240):
        """Wait until Nocheh has sent nothing for `seconds`, so a late notice of an earlier scenario (an import's
        "ready" message) is not counted as the next turn's reply."""
        state = {'count': len(self.f.sent()), 'since': time.monotonic()}

        def quiet():
            count = len(self.f.sent())
            if count != state['count']:
                state.update(count=count, since=time.monotonic())
            return time.monotonic()-state['since'] >= seconds
        self.wait('sends_quiet', quiet, limit, interval=3)

    def restart_preserves_receipts(self):
        # A mark said in the private chat and in a group topic before the restart, which each chat's next turn must
        # still have in its own history, not only in memory.
        self.sends_quiet()
        self.turn(self.f.message(OWNER, 'یادت باشد: HISTMARK-PRIVATE-31'), OWNER)
        self.turn(self.f.message(GROUP, 'یادت باشد: HISTMARK-GROUP-31', topic=11), GROUP, 11)
        sent = len(self.f.sent())
        self.wait('updates_acknowledged', lambda: not self.f.telegram()['updates'], 120)
        # The whole runtime restarts: the Telegram service with its delivery receipts, and the agent.
        self.f.run('restart', '--no-deps', TELEGRAM_SERVICE, 'hermes')
        self.f.run('up', '-d', '--no-build', '--no-deps', '--wait', TELEGRAM_SERVICE, 'hermes')
        wait_telegram_connected(self.wait, self.f.command, 'polling_reconnected')
        time.sleep(10)
        self.gate('restart_sends_nothing', len(self.f.sent()) == sent)
        self.history_kept('after_restart')

    def upgraded_copy_keeps_history(self):
        # full_test --upgrade: every container was made again on the new images.
        wait_telegram_connected(self.wait, self.f.command, 'polling_after_upgrade', 300)
        self.history_kept('after_upgrade')

    def history_kept(self, when):
        """The private chat and the group topic each still have their mark in the agent's session history."""
        _, text = self.turn(self.f.message(OWNER, 'قبلا چه گفتم؟ [[history:HISTMARK-PRIVATE-31]]'), OWNER)
        self.gate('private_history_kept_'+when, 'present' in text, answer=text)
        _, text = self.turn(self.f.message(GROUP, 'قبلا چه گفتم؟ [[history:HISTMARK-GROUP-31]]', topic=11), GROUP, 11)
        self.gate('group_history_kept_'+when, 'present' in text, answer=text)

    def granted_participant(self):
        # The owner makes someone a member by their Telegram user ID, with only OTHER_GROUP ticked, through the dashboard's
        # Members routes: they talk there at once, with no restart. Switching OTHER_GROUP off for them takes effect at once
        # too: they get the fixed reply there, as a stranger does. Removed, they are a stranger again. A person new to the
        # fixture, since everyone gets the fixed reply at most once a UTC day per group.
        person = self.fresh_person()
        starts = self.service_starts()
        item = self.add_member(person, (OTHER_GROUP,))
        try:
            self.gate('member_listed_with_their_group', item['state'] == 'active' and any(row['chat_id'] == self.f.chat(OTHER_GROUP) and row['on']
                                                                                    for row in item['groups']), member=item)
            self.turn(self.f.message(OTHER_GROUP, 'سلام، اجازه دارم؟', sender=person, topic=22), OTHER_GROUP, 22)
            item = self.change_member(self.member_item(person), groups={OTHER_GROUP: False})
            self.not_allowed_reply(self.f.message(OTHER_GROUP, 'هنوز اجازه دارم؟', sender=person, topic=22), 22, chat=OTHER_GROUP)
        finally:
            self.remove_member(item)
        self.gate('not_listed_after_removal', self.member_item(person) is None)
        self.nothing_restarted(starts)

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
        self.gate('retention_reported', result['retention_days'] == 0 and result['docker_logs']['max_files_per_container'] >= 1)
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


ORDER = ['reply_during_polling_reconnect', 'ordinary_private', 'hermes_is_locked_down', 'edit_is_silent', 'reaction_is_silent', 'general_after_topics', 'burst_in_order', 'private_burst_in_order', 'long_reply_chunks',
         'intentional_silence', 'empty_answer_is_not_silence', 'private_fact_and_search', 'owner_private_context', 'group_cannot_see_private',
         'owner_recall', 'secret_is_guarded', 'document_reply', 'action_approval', 'action_denial', 'group_current_action', 'schedule_fires_and_sends_without_card', 'participant_not_permitted',
         'group_answers_only_when_addressed', 'unselected_group', 'retirement_hides_fact', 'voice_is_transcribed', 'long_voice_is_read_whole_from_everyone', 'photo_is_read',
         'files_upload_over_1mb', 'profiles_round_trip', 'no_refused_writes',
         'owner_directory_lists_conversations', 'unparseable_update_does_not_wedge_polling', 'telegram_refresh_names', 'owner_freedom_keeps_group_cards', 'launcher_stop_mid_turn', 'deleted_topic', 'polling_outage', 'lost_send_response',
         'blocked_private_then_recovery', 'restart_preserves_receipts', 'granted_participant', 'storage_report', 'stage_timings']


def run(directory, names, scenarios_class=Scenarios):
    """Run the named scenarios on a prepared fixture and save one report."""
    fixture = Fixture(directory)
    if fixture.query('nocheh_control', "SELECT current_setting('cluster_name')") != 'nocheh-installation-fixture':
        raise ValueError('synthetic_cluster_required')
    if fixture.manifest['services'][TELEGRAM_SERVICE].get('command') != ['python', '-m', 'tools.acceptance.telegram_runtime']:
        raise ValueError('run_telegram_rehearsal_first')
    report = directory/('telegram-scenarios-'+str(time.time_ns()))
    report.mkdir(mode=0o700)
    initial = fixture.telegram()
    if initial['faults']:
        raise ValueError('previous_fixture_faults_pending')
    scenarios = scenarios_class(fixture, report)
    scenarios.state = {}
    for name in names:
        scenarios.execute(name, getattr(scenarios, name))
    final = fixture.telegram()
    project_networks = {value['name'] for value in fixture.manifest['networks'].values()}
    def turns():
        listed = isolated_turns('-a', '--format', '{{json .}}')
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
    if lingering and backlog() != '0':
        # Reviews still queued at the time limit keep starting short turns, so a turn
        # running now is not a leak. One still there after the launcher's own turn
        # limit has passed is.
        first = {row.get('ID') for row in lingering}
        time.sleep(300)
        lingering = [row for row in turns() if row.get('ID') in first]
    scenarios.current = {'scenario': 'no_lingering_isolated_turns', 'gates': [], 'passed': not lingering}
    scenarios.current['observed'] = {'containers': len(lingering), 'native_reviews_pending_at_end': int(pending),
                                     'native_reviews_left': int(backlog()),
                                     'native_reviews_awaiting_receipt': int(count("state='waiting' AND waiting_reason='receipt_pending'")), 'drain_seconds': round(time.monotonic()-started, 1)}
    scenarios.results.append(scenarios.current)
    summary = {'passed': all(row['passed'] for row in scenarios.results), 'live_acceptance': False,
               'provider': 'deterministic-fixture-with-scripted-agent', 'scenarios': scenarios.results,
               'unknown_methods': final['unknown'][len(initial['unknown']):], 'stats': fixture.http('/fixture/stats')}
    (report/'result.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps({'passed': summary['passed'], 'failed': [row['scenario'] for row in scenarios.results if not row['passed']],
                      'unknown_methods': summary['unknown_methods'], 'report': str(report/'result.json')}, ensure_ascii=False), flush=True)
    return summary, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--only', nargs='*', choices=ORDER)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_relative_to(ROOT/'data/acceptance/results'):
        raise ValueError('owned_fixture_directory_required')
    run(directory, args.only or ORDER)


if __name__ == '__main__':
    main()
