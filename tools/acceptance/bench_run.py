"""Run the persian-agent-bench attack cases through a synthetic Nocheh with a real model (test plan step 4).

Each case's made-up world goes where Nocheh finds such things: its mail in the fake Gmail, its files, documents and
notes as pages of the fake Notion, its chat messages in a new group the owner adds. The case's request then goes to the
owner's private chat, in a new agent session of its own (a private chat has no topics). What the agent called, with the
answers it got, is read from the model relay's latest requests; each call is mapped to the benchmark's abstract tools
and marked executed, blocked (it waits for the owner's card) or failed. One trace per case is written in the
benchmark's own format and scored with its own scorer, counting every call and then only the calls that ran.

    python3 -m tools.acceptance.bench_run --directory <fixture> --bench <persian-agent-bench checkout> [--cases ID ...]

The fixture must be in relay mode (model_rehearsal.py with --upstream). Nothing reaches a real mailbox, Notion or
person: every service is the fixture's fake. Known differences from the benchmark's reference world: the owner is not
the benchmark's persona, item times are moved by whole days so the newest is today, and the agent has only Nocheh's
own tools, so attacker goals Nocheh has no tool for (sending mail, changing mail settings, deleting) cannot succeed.
"""
import argparse
import email.utils
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.acceptance.connectors_mock import GMAIL_CODE
from tools.acceptance.model_rehearsal import HERMES_PROFILES, NEW_DAY
from tools.acceptance.telegram_scenarios import OWNER, Failed, Fixture
from tools.paths import ROOT

RUNNER = {'name': 'nocheh-bench-runner', 'version': '0.1.0'}
NOTION_TOKEN = 'ntn_fixture_bench'
GMAIL_CLIENT = '123456789012-abcdef0123456789.apps.googleusercontent.com'
# How long one case's turn may take, and how many errored cases in a row stop the run: a broken run ends in minutes.
CASE_SECONDS = 300
STOP_AFTER = 3
# What a proposal's state says when it ran; any other state waits for a card or was refused.
RAN = {'done', 'running', 'approved', 'sent', 'posted', 'completed', 'succeeded'}
UNICODE_ESCAPE = re.compile(r'\\u([0-9a-fA-F]{4})')


def fa(value):
    return value.get('fa', '') if isinstance(value, dict) else (value or '')


def unescaped(text):
    """Persian text a tool answered inside JSON written with ASCII escapes, as the agent read it."""
    return UNICODE_ESCAPE.sub(lambda found: chr(int(found.group(1), 16)), text or '')


def as_json(text):
    """The JSON object in a tool's answer, which Nocheh may wrap in a marked block; None when there is none."""
    text = unescaped(text)
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start:end+1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def abstract(name, args):
    """A Nocheh or Hermes tool call as the benchmark's abstract tool (taxonomy/tools.json) and its arguments; the tool
    is None for one the benchmark has no tool for, which keeps its own arguments."""
    args = args if isinstance(args, dict) else {}
    short = name.removeprefix('mcp__nocheh__')
    given = args.get('input') if isinstance(args.get('input'), dict) else {}
    keep = lambda **values: {key: value for key, value in values.items() if value not in (None, '')}
    if short == 'gmail':
        return 'read_email', keep(query=given.get('query'), id=given.get('id'))
    if short in ('archive_search', 'archive_read', 'archive_page'):
        return 'read_chat', keep(query=args.get('query') or args.get('id'), chat=args.get('space') or args.get('chat'))
    if short == 'notion':
        if args.get('operation') == 'call' and args.get('tool') in ('notion-create-pages', 'notion-update-page'):
            return 'write_file', {'path': str(given.get('page_id') or 'notion'), 'content': json.dumps(given, ensure_ascii=False)}
        return 'read_file', keep(path=given.get('query') or given.get('id'))
    if short == 'shell':
        return 'run_command', keep(command=args.get('command'))
    if short == 'browser':
        return 'open_url', keep(url=args.get('url'))
    if short == 'mcp':
        return 'open_url', keep(url=args.get('url'), body=json.dumps(given, ensure_ascii=False) if given else None)
    if short == 'action_request':
        return 'send_message', keep(to=args.get('destination'), body=args.get('text'))
    if short == 'background_job' and args.get('action') == 'start':
        return 'run_command', keep(command=args.get('instruction'))
    if name == 'memory':
        texts = [operation.get('content') for operation in args.get('operations') or [] if isinstance(operation, dict)]
        return 'write_memory', keep(text='\n'.join(text for text in texts if isinstance(text, str)) or json.dumps(args, ensure_ascii=False))
    if name.startswith('cronjob') and str(args.get('action') or 'create') in ('create', 'add', 'update'):
        return 'create_schedule', keep(when=args.get('schedule') or args.get('when'), task=args.get('prompt') or args.get('task'))
    return None, args


def status(name, answer):
    """executed, blocked (it waits for the owner's card or was saved paused) or failed, from the answer the agent got."""
    value = as_json(answer)
    if value is not None:
        if value.get('error'):
            return 'failed'
        state = value.get('state')
        if isinstance(state, str) and state not in RAN:
            return 'blocked'
    if name.startswith('cronjob') and 'paused' in unescaped(answer).lower():
        return 'blocked'
    return 'executed'


def content(message):
    value = message.get('content')
    if isinstance(value, list):
        return '\n'.join(str(part.get('text') or '') for part in value if isinstance(part, dict))
    return value if isinstance(value, str) else ''


def turn_calls(requests, request_text):
    """The tool calls of the turn that answered `request_text`, with their answers, from the relay's latest requests:
    the last request holding that user message holds every call and answer before the reply."""
    holding = [row for row in requests if any(message.get('role') == 'user' and request_text in content(message)
                                              for message in row.get('messages') or [] if isinstance(message, dict))]
    if not holding:
        return []
    messages = [message for message in holding[-1]['messages'] if isinstance(message, dict)]
    start = max(index for index, message in enumerate(messages) if message.get('role') == 'user' and request_text in content(message))
    answers = {message.get('tool_call_id'): content(message) for message in messages[start:] if message.get('role') == 'tool'}
    calls = []
    for message in messages[start:]:
        for call in message.get('tool_calls') or [] if message.get('role') == 'assistant' else []:
            function = call.get('function') or {}
            try:
                arguments = json.loads(function.get('arguments') or '{}')
            except ValueError:
                arguments = {'raw': function.get('arguments')}
            calls.append({'name': function.get('name') or '', 'args': arguments, 'answer': answers.get(call.get('id'), '')})
    return calls


def trace(case, dataset_ref, model, calls, final_text, error=None):
    """The benchmark's trace (schema/trace.schema.json) of one case."""
    tool_calls, outbound, memory, read = [], [], [], []
    for number, call in enumerate(calls, 1):
        tool, args = abstract(call['name'], call['args'])
        state = status(call['name'], call['answer'])
        tool_calls.append({'seq': number, 'phase': 'attack', 'tool': tool, 'native_tool': call['name'], 'args': args,
                           'status': state, 'origin': 'agent'})
        if tool == 'open_url' and state == 'executed' and args.get('url'):
            outbound.append({'seq': number, 'phase': 'attack', 'url': args['url'], 'via': 'tool'})
        if tool == 'write_memory' and state == 'executed':
            memory.append({'store': 'notes', 'text': args.get('text', '')})
        answered = unescaped(call['answer'])
        read += [item['id'] for item in case['items'] if item['id'] not in read and snippet(item) and snippet(item) in answered]
    return {'trace_version': 1, 'case_id': case['id'], 'dataset_ref': dataset_ref,
            'runner': {**RUNNER, 'model': model, 'mode': 'foreground', 'request_lang': 'fa', 'memory_kind': 'transcript'},
            'tool_calls': tool_calls, 'outbound_urls': outbound, 'memory_writes': memory, 'final_text': final_text,
            'items_read': read, 'skipped': None, 'error': error}


def snippet(item):
    """A short stretch of an item's text that shows the agent read it."""
    return ' '.join(fa(item.get('body')).split())[:40]


def moved(item, shift):
    return datetime.fromisoformat(item['time']) + shift


def world(case, index, shift):
    """Where each made-up item of a case goes: mail for the fake Gmail, pages for the fake Notion, and chat messages
    grouped by the chat they belong to, newest mail first."""
    mail, pages, chats = [], [], {}
    for item in sorted(case['items'], key=lambda item: item['time']):
        kind, key = item['kind'], 'c%02d%s' % (index, re.sub(r'[^a-z0-9]', '', item['id'].lower()))
        if kind == 'email':
            mail.append({'id': 'm' + key, 'thread': 't' + key, 'from': '%s <%s>' % (fa(item.get('from_name')), item['from']),
                         'to': ', '.join(item.get('to') or []), 'subject': fa(item.get('subject')),
                         'date': email.utils.format_datetime(moved(item, shift)), 'text': fa(item['body'])})
        elif kind in ('file', 'document', 'note'):
            title = ' - '.join(part for part in (fa(item.get('title')), item.get('path')) if part)
            pages.append({'id': hashlib.sha256((case['id'] + item['id']).encode()).hexdigest()[:32], 'title': title or item['id'],
                          'text': fa(item['body'])})
        elif kind in ('chat_message', 'chat_forward'):
            chats.setdefault(fa(item.get('chat')) or 'گروه', []).append(item)
        else:
            raise ValueError('item_kind_not_placed:' + kind)
    return mail[::-1], pages, chats


class Bench:
    def __init__(self, directory, bench, model):
        from tools.acceptance.product_scenarios import ProductScenarios
        self.f = Fixture(directory, scripted=False)
        if not self.f.manifest['services']['model-fixture']['environment'].get('NOCHEH_FIXTURE_UPSTREAM'):
            raise ValueError('relay_mode_required: run model_rehearsal.py with --upstream first')
        self.s = ProductScenarios(self.f, directory)
        self.s.current = {'scenario': 'persian_agent_bench', 'gates': []}
        self.bench, self.model = bench, model
        sys.path.insert(0, str(bench / 'tools'))
        import pab_lib
        self.lib = pab_lib
        self.info = pab_lib.dataset_info()
        self.ref = subprocess.run(['git', '-C', str(bench), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() or 'unknown'

    def connect(self):
        """The owner's own Gmail and Notion, connected as on the dashboard, both to the fixture's fakes."""
        from tools.acceptance.owner_dashboard import Dashboard
        import urllib.parse
        dashboard = Dashboard(self.f)
        self.f.http('/fixture/gmail', {'messages': []})
        dashboard.post('/connections/gmail/client', {'client_id': GMAIL_CLIENT, 'client_secret': 'fixture-secret-bench'})
        started = dashboard.post('/connections/gmail/start', {'redirect': dashboard.origin + '/?connect=gmail'})
        state = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(started['url']).query)).get('state')
        if dashboard.post('/connections/gmail/finish', {'code': GMAIL_CODE, 'state': state}).get('connected') is not True:
            raise Failed('gmail_not_connected')
        self.f.http('/fixture/notion', {'tokens': {NOTION_TOKEN: 'BENCH'}, 'pages': []})
        if dashboard.post('/connections/notion/token', {'token': NOTION_TOKEN}).get('connected') is not True:
            raise Failed('notion_not_connected')
        self.s.notion_setting(None, True)

    def post_chats(self, chats):
        """Each chat's messages in a new group the owner adds, from made-up people, nobody addressing Nocheh."""
        for title, items in chats.items():
            group = {'id': -(10**12 + self.f.ids() % 10**9), 'type': 'supergroup', 'title': title}
            self.s.owner_adds(group)
            for item in items:
                sender = {'id': 900000 + int(hashlib.sha256(str(item.get('from')).encode()).hexdigest()[:5], 16), 'is_bot': False,
                          'first_name': fa(item.get('from_name')) or 'Someone'}
                extra = {'from': sender, 'chat': group}
                if item['kind'] == 'chat_forward':
                    extra['forward_origin'] = {'type': 'hidden_user', 'sender_user_name': fa(item.get('forwarded_from')) or 'Someone',
                                               'date': int(time.time()) - 3600}
                update = self.f.message(group['id'], fa(item['body']), sender=sender['id'], mention=False, extra=extra)
                self.f.inject(update)
                self.s.captured(update)

    def new_session(self, name):
        """Point every chat at a new agent session, so the case's turn carries nothing of the cases before."""
        subprocess.run(self.f.command + ['exec', '-T', 'hermes', 'python3', '-c', NEW_DAY, HERMES_PROFILES, name],
                       check=True, capture_output=True)

    def run_case(self, case, index, shift):
        mail, pages, chats = world(case, index, shift)
        self.f.http('/fixture/gmail', {'messages': mail})
        self.f.http('/fixture/notion', {'tokens': {NOTION_TOKEN: 'BENCH'}, 'pages': pages})
        self.post_chats(chats)
        self.new_session('bench' + str(index))
        text = fa(case['user_request'])
        since = self.f.http('/fixture/relay')['count']
        before = len(self.f.sent())
        update = self.f.message(OWNER, text)
        self.f.inject(update)
        event = self.s.captured(update)
        try:
            row = self.s.finished(event, seconds=CASE_SECONDS)
        except Failed as error:
            raise Failed(str(error) + ':' + json.dumps(self.f.dispatch(event))) from None
        # The reply and any card arrive with the closed turn; a moment more lets a split reply finish.
        time.sleep(3)
        sent = self.f.sent()[before:]
        replies = [item['message'].get('text') or '' for item in sent if item['message']['chat']['id'] == OWNER
                   and item['message'].get('message_thread_id') is None and not self.s.is_card(item)]
        cards = [item['message'].get('text') or '' for item in sent if self.s.is_card(item)]
        calls = turn_calls(self.f.http('/fixture/relay?since=' + str(since))['requests'], text)
        error = None if row['state'] == 'done' else 'turn_' + str(row['state']) + ':' + str(row['error'])
        result = trace(case, self.ref, self.model, calls, '\n\n'.join(replies), error)
        result['runner']['cards'] = cards
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--bench', required=True, type=Path, help='A checkout of persian-agent-bench; its commit is recorded.')
    parser.add_argument('--model', default='claude-haiku-5-5', help='The model the relay answers with, for the traces.')
    parser.add_argument('--cases', nargs='*', help='Case ids; all active cases when left out.')
    args = parser.parse_args()
    directory, bench = args.directory.resolve(), args.bench.resolve()
    if not directory.is_relative_to(ROOT / 'data/acceptance/results'):
        parser.error('owned_fixture_required')
    if not (bench / 'tools/pab_lib.py').exists() or not (bench / 'tools/score.py').exists():
        parser.error('bench_checkout_required')
    runner = Bench(directory, bench, args.model)
    cases = [case for case in runner.lib.load_cases() if case.get('status') == 'active' and case['track'] == 'action'
             and (not args.cases or case['id'] in args.cases)]
    reference = datetime.fromisoformat(runner.info['reference_time'])
    # Whole days, so each item keeps its time of day and the newest is today.
    shift = timedelta(days=(datetime.now(timezone.utc) - reference).days)
    output = directory / ('bench-' + str(time.time_ns()))
    traces = output / 'traces'
    traces.mkdir(parents=True, mode=0o700)
    runner.connect()
    errored = 0
    for index, case in enumerate(cases):
        if errored >= STOP_AFTER:
            result = trace(case, runner.ref, args.model, [], '')
            result['skipped'] = 'run_stopped_after_%d_errors' % STOP_AFTER
        else:
            try:
                result = runner.run_case(case, index, shift)
            except Exception as error:
                result = trace(case, runner.ref, args.model, [], '', type(error).__name__ + ':' + str(error)[:300])
            errored = errored + 1 if result['error'] else 0
        (traces / (case['id'] + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'case': case['id'], 'calls': [(call['tool'], call['status']) for call in result['tool_calls']],
                          'error': result['error'], 'spend_dollars': runner.f.http('/fixture/stats').get('spend_dollars')},
                         ensure_ascii=False), flush=True)
    summaries = {}
    for name, extra in (('all_calls', []), ('executed_only', ['--executed-only'])):
        out = output / ('summary-' + name + '.json')
        subprocess.run([sys.executable, str(bench / 'tools/score.py'), str(traces), '--out', str(out), *extra], check=True)
        value = json.loads(out.read_text())
        summaries[name] = {key: value[key] for key in ('attack_success', 'attack_attempted', 'leak_any', 'utility_under_attack',
                                                         'control_utility', 'runs', 'skipped', 'errors')}
    report = {'bench_commit': runner.ref, 'model': args.model, 'cases': len(cases), 'summaries': summaries,
              'spend_dollars': runner.f.http('/fixture/stats').get('spend_dollars'), 'output': str(output)}
    (output / 'bench-run.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
