"""Review replay: relay, driver and statistics, on synthetic data only."""
import contextlib
import io
import json
import os
import re
import socket
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from tools.development.review_replay import driver, relay

KEY = '0123abcd' * 8
EVENT = 'fedc9876' * 8
SOURCE_TEXT = 'Synthetic fragment: the replay probe mentions a teal bicycle.'
NOTE = 'Synthetic replay note: the owner prefers teal bicycles.'
KEPT = 'Synthetic kept note about a garden.'
STALE = f'Synthetic stale note [nocheh:event:{EVENT}].'
PROVIDER_KEY = 'synthetic-provider-key-0000'
ADD = {'target': 'memory', 'operations': [{'action': 'add', 'content': NOTE}]}
# The test's stand-in for the container's --add-host nocheh-security:127.0.0.1.
SITE = '''import socket
_getaddrinfo = socket.getaddrinfo
def getaddrinfo(host, port, *args, **kwargs):
    if host == 'nocheh-security' and str(port) == '8786': host, port = '127.0.0.1', %d
    return _getaddrinfo(host, port, *args, **kwargs)
socket.getaddrinfo = getaddrinfo
'''


# What Anthropic sends inside a stream that already answered 200 when it is overloaded; Hermes retries the call.
OVERLOADED = {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Synthetic upstream detail.'}}


def anthropic_stream(model, done, thinking=True, error=False):
    events = [{'type': 'message_start', 'message': {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None,
               'usage': {'input_tokens': 100, 'cache_creation_input_tokens': 900, 'cache_read_input_tokens': 0, 'output_tokens': 1}}}]
    index = 0
    if error:
        events.append(OVERLOADED)
    elif thinking and not done:
        events += [{'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}},
                   {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'Synthetic thought.'}},
                   {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': 'c2lnbmF0dXJl'}},
                   {'type': 'content_block_stop', 'index': 0}]
        index = 1
    if done and not error:
        events += [{'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}},
                   {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': 'Done.'}},
                   {'type': 'content_block_stop', 'index': index}, {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 3}},
                   {'type': 'message_stop'}]
    elif not error:
        raw = json.dumps(ADD)
        events += [{'type': 'content_block_start', 'index': index, 'content_block': {'type': 'tool_use', 'id': 'toolu_1', 'name': 'memory', 'input': {}}},
                   {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': raw[:20]}},
                   {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': raw[20:]}},
                   {'type': 'content_block_stop', 'index': index}, {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 20}},
                   {'type': 'message_stop'}]
    return b''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode() for event in events)


def chat_stream(model, done, arguments=None):
    base = {'id': 'chat_1', 'object': 'chat.completion.chunk', 'model': model}
    if done:
        chunks = [{**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'Done.'}, 'finish_reason': None}]},
                  {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}]
    else:
        raw = json.dumps(arguments or ADD)
        chunks = [{**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [
                      {'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': 'memory', 'arguments': raw[:20]}}]}, 'finish_reason': None}]},
                  {**base, 'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': raw[20:]}}]}, 'finish_reason': None}]},
                  {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]}]
    chunks.append({**base, 'choices': [], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 20, 'total_tokens': 1020,
                                                   'prompt_tokens_details': {'cached_tokens': 0}}})
    return b''.join(f'data: {json.dumps(chunk)}\n\n'.encode() for chunk in chunks) + b'data: [DONE]\n\n'


class Provider(BaseHTTPRequestHandler):
    """A scripted provider on both routes: a memory tool call adding a note, then, once the request holds its result, final text.
    With overload set, the first Messages API call without a thinking setting (arm B) gets an error inside its 200 stream."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        chat = self.path == '/v1/chat/completions'
        messages = body.get('messages') or []
        done = any(m.get('role') == 'tool' for m in messages) if chat else any(
            isinstance(m.get('content'), list) and any(b.get('type') == 'tool_result' for b in m['content']) for m in messages)
        system = body.get('system') if not chat else next((m.get('content') for m in messages if m.get('role') == 'system'), None)
        system = system if isinstance(system, str) else ''.join(b.get('text', '') for b in system or [] if isinstance(b, dict))
        self.server.seen.append({'path': self.path, 'stream': body.get('stream'), 'thinking': 'thinking' in body, 'system': system,
                                 'body': json.dumps(body), 'headers': {k.lower(): v for k, v in self.headers.items()}})
        if self.server.fail:
            data, status, kind = json.dumps({'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Synthetic upstream detail.'}}).encode(), self.server.fail, 'application/json'
        elif body.get('stream'):
            error = not chat and 'thinking' not in body and self.server.overload
            self.server.overload &= not error
            data, status, kind = (chat_stream(body['model'], done) if chat else anthropic_stream(body['model'], done, error=error)), 200, 'text/event-stream'
        elif chat:
            message = {'role': 'assistant', 'content': 'Done.'} if done else {'role': 'assistant', 'content': None, 'tool_calls': [
                {'id': 'call_1', 'type': 'function', 'function': {'name': 'memory', 'arguments': json.dumps(ADD)}}]}
            data, status, kind = json.dumps({'id': 'chat_1', 'object': 'chat.completion', 'model': body['model'], 'choices': [
                {'index': 0, 'message': message, 'finish_reason': 'stop' if done else 'tool_calls'}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 20}}).encode(), 200, 'application/json'
        else:
            content = [{'type': 'text', 'text': 'Done.'}] if done else [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'memory', 'input': ADD}]
            data, status, kind = json.dumps({'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': body['model'], 'content': content,
                                             'stop_reason': 'end_turn' if done else 'tool_use', 'usage': {'input_tokens': 100, 'output_tokens': 20}}).encode(), 200, 'application/json'
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def provider():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    server.seen, server.fail, server.overload, server.handle_error = [], None, False, lambda *args: None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def template(folder):
    profile = folder / 'template'
    (profile / 'memories').mkdir(parents=True)
    (profile / 'config.yaml').write_text('{}\n')
    (profile / 'memories' / 'MEMORY.md').write_text(driver.ENTRY_DELIMITER.join([KEPT, STALE]))
    (profile / 'memories' / 'USER.md').write_text('Synthetic user note.')
    return profile


def sources(folder, count=1):
    path = folder / 'sources.jsonl'
    path.write_text(''.join(json.dumps({'key': f'{n:x}' * 64 if count > 1 else KEY, 'event_id': EVENT, 'kind': driver.KINDS[n % 3],
                                        'text': f'Source nocheh:event:{EVENT}; conversation synthetic; fragment 1.\n{SOURCE_TEXT}'}) + '\n'
                            for n in range(count)))
    return path


class EndToEnd(unittest.TestCase):
    def test_three_arms_through_the_relay_and_the_live_review_subprocess(self):
        upstream = provider()
        upstream.overload = True
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as name:
            folder, port = Path(name), free_port()
            (folder / 'site').mkdir()
            (folder / 'site' / 'sitecustomize.py').write_text(SITE % port)
            profile, out, turn = template(folder), folder / 'out', folder / 'turn'
            original = (profile / 'memories' / 'MEMORY.md').read_bytes()
            argv = ['--sources', str(sources(folder)), '--profile', str(profile), '--context-length', '1000000', '--repeats', '1',
                    '--memory-context', 'evidence', '--seed', '3', '--broker', f'http://127.0.0.1:{port}', '--out', str(out), '--keep-homes',
                    '--turn-home', str(turn / 'profile'), '--user-home', str(turn / 'home')]
            environment = {'REPLAY_PROVIDER_KEY': PROVIDER_KEY, 'REPLAY_UPSTREAM': 'http://127.0.0.1:%d' % upstream.server_address[1],
                           'PYTHONPATH': os.pathsep.join([str(folder / 'site'), os.environ.get('PYTHONPATH', '')])}
            mask = os.umask(0o022)
            with mock.patch.dict(os.environ, environment), contextlib.redirect_stdout(io.StringIO()) as printed:
                driver.main(argv)
            # The driver ran with umask 077 (the files below are its own) and gave the caller's umask back.
            self.assertEqual(os.umask(mask), 0o022)
            rows = {row['arm']: row for row in driver.load(out / 'results.jsonl')}
            self.assertEqual(set(rows), {'A', 'B', 'C'})
            for arm, row in rows.items():
                # B's first call was retried after an error inside its 200 stream: still two calls, as Hermes counts them.
                self.assertEqual((row['state'], row['calls'], row['hermes_calls'], row['unaccounted']), ('done', 2, 2, None), arm)
                self.assertEqual((row['failed_calls'], row['stream_errors']), (1, 1) if arm == 'B' else (0, 0), arm)
                self.assertEqual(row['memory_ops'], {'add:memory': 1})
                self.assertEqual((row['notes_before'], row['notes_after'], row['dropped_entries']), ({'MEMORY.md': 1, 'USER.md': 1}, {'MEMORY.md': 2, 'USER.md': 1}, 1))
                self.assertTrue(row['memory_changed'] and row['notes_changed'] and not row['user_changed'])
                calls = [call for call in row['call_detail'] if call['kind'] == 'call']
                self.assertEqual({call['route'] for call in calls}, {'chat' if arm == 'A' else 'messages'})
                self.assertEqual({call['evidence'] for call in calls}, {'separate_message' if arm == 'A' else 'first_block'})
                self.assertEqual({call['thinking'] for call in calls}, {'between_tools' if arm == 'C' else None})
                self.assertTrue(all(call['stream'] for call in calls))
                # The run's own home holds the note; the stale entry citing the source was dropped before the run.
                notes = (out / 'homes' / row['run_id'] / 'memories' / 'MEMORY.md').read_text()
                self.assertIn(NOTE, notes)
                self.assertNotIn(STALE, notes)
            self.assertEqual(next(call for call in rows['B']['call_detail'] if driver.completed(call))['thinking_blocks'], 1)
            # Every run is the default profile at one fixed home: no run, arm or repeat label reaches the provider, and B and C
            # send the same system prompt (Hermes dates it, so the date line is left out).
            stable = lambda text: [line for line in text.splitlines() if not line.startswith('Conversation started')]
            for seen in upstream.seen:
                self.assertIn('Active Hermes profile: default.', seen['system'])
                self.assertFalse(any(label in seen['body'] for label in [row['run_id'] for row in rows.values()] + ['turn.replay', 'homes']))
            self.assertEqual(len({json.dumps(stable(seen['system'])) for seen in upstream.seen if seen['path'] == '/v1/messages'}), 1)
            self.assertEqual(list((turn / 'profile').iterdir()), [])
            self.assertFalse((turn / 'home').exists())
            # The template is 0644 under the test's umask; the run's copy and all Hermes wrote there are the driver's alone.
            self.assertEqual(stat.S_IMODE((profile / 'config.yaml').stat().st_mode), 0o644)
            kept = [path for path in (out / 'homes').rglob('*') if not path.is_symlink()]
            self.assertTrue(any(path.name == 'config.yaml' for path in kept))
            self.assertEqual([path.name for path in kept if stat.S_IMODE(path.stat().st_mode) & 0o077], [])
            self.assertEqual(Counter(seen['path'] for seen in upstream.seen), {'/v1/chat/completions': 2, '/v1/messages': 5})
            self.assertEqual(Counter(seen['thinking'] for seen in upstream.seen if seen['path'] == '/v1/messages'), {True: 2, False: 3})
            for seen in upstream.seen:
                headers = seen['headers']
                self.assertEqual(headers.get('x-api-key') or headers.get('authorization'), PROVIDER_KEY if seen['path'] == '/v1/messages' else 'Bearer ' + PROVIDER_KEY)
                self.assertFalse(any('turn.replay.' in value for value in headers.values()))
            self.assertEqual((profile / 'memories' / 'MEMORY.md').read_bytes(), original)
            # Nothing the replay wrote outside the run homes holds the source or note text: not the results, not the relay log.
            for path in out.rglob('*'):
                if path.is_file() and (out / 'homes') not in path.parents:
                    text = path.read_text(errors='replace')
                    for secret in (SOURCE_TEXT, NOTE, KEPT, PROVIDER_KEY):
                        self.assertNotIn(secret, text, path.name)
            for name in ('results.jsonl', 'calls.jsonl'):
                self.assertEqual(stat.S_IMODE((out / name).stat().st_mode), 0o600)
            log = driver.load(out / 'calls.jsonl')
            self.assertTrue(any(entry['kind'] == 'other' and entry['status'] == 403 for entry in log))
            self.assertFalse(any(entry.get('refused') == 'replay_destination_denied' for entry in log))
            self.assertIn('B-A multi_call_share', printed.getvalue())
            self.assertIn('C thinking sent: between_tools x2', printed.getvalue())
            self.assertIn('B thinking sent: none x3', printed.getvalue())
            with contextlib.redirect_stdout(io.StringIO()) as analyzed:
                driver.main(['--analyze', str(out / 'results.jsonl')])
            self.assertIn('A-vs-A notes changed', analyzed.getvalue())
            self.assertIn('C-A notes_changed_share: +0.000 over 1 sources', analyzed.getvalue())


class Driver(unittest.TestCase):
    def test_drops_only_whole_entries_that_cite_the_source(self):
        with tempfile.TemporaryDirectory() as name:
            memories = Path(name)
            entries = [KEPT, f'Line one.\nLine two cites nocheh:event:{EVENT} here.', 'Synthetic last note.']
            (memories / 'MEMORY.md').write_text(driver.ENTRY_DELIMITER.join(entries))
            (memories / 'USER.md').write_text('Synthetic user note.')
            self.assertEqual(driver.drop_entries(memories, EVENT), 1)
            self.assertEqual((memories / 'MEMORY.md').read_text(), driver.ENTRY_DELIMITER.join([entries[0], entries[2]]))
            self.assertEqual((memories / 'USER.md').read_text(), 'Synthetic user note.')
            self.assertEqual(driver.drop_entries(memories, 'ab' * 32), 0)

    def test_a_run_that_fails_leaves_no_profile_copy(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            args = driver.arguments(['--sources', 's', '--profile', str(template(folder)), '--context-length', '1', '--out', str(folder / 'out'),
                                     '--turn-home', str(folder / 'turn'), '--user-home', str(folder / 'user')])
            (folder / 'turn').mkdir()

            def prepare_home(template, home, event_id):
                (home / 'memories').mkdir()
                (home / 'memories' / 'MEMORY.md').write_text(KEPT)
                (folder / 'user').mkdir()
                raise OSError('synthetic')
            with mock.patch.object(driver, 'prepare_home', prepare_home), self.assertRaises(OSError):
                driver.execute({'key': KEY, 'event_id': EVENT, 'kind': 'i', 'text': SOURCE_TEXT}, 'A', 1, '0001-A1', args, None, {})
            self.assertEqual(list((folder / 'turn').iterdir()), [])
            self.assertFalse((folder / 'user').exists())

    def test_entry_delimiter_matches_hermes(self):
        import tools
        found = [Path(p) / 'memory_tool_store.py' for p in tools.__path__ if (Path(p) / 'memory_tool_store.py').is_file()]
        self.assertTrue(found)
        self.assertIn('ENTRY_DELIMITER = "\\n§\\n"', found[0].read_text())

    def test_runs_interleave_arms_within_each_source_in_a_seeded_order(self):
        rows = [{'key': str(n)} for n in range(4)]
        runs = driver.schedule(rows, ['A', 'B', 'C'], 2, seed=5)
        self.assertEqual(len(runs), 24)
        self.assertEqual(runs, driver.schedule(rows, ['A', 'B', 'C'], 2, seed=5))
        self.assertNotEqual([(s['key'], a) for s, a, _ in runs], [(s['key'], a) for s, a, _ in driver.schedule(rows, ['A', 'B', 'C'], 2, seed=6)])
        for start in range(0, 24, 6):
            self.assertEqual(len({source['key'] for source, _, _ in runs[start:start + 6]}), 1)
        for start in range(0, 24, 3):
            self.assertEqual(sorted(arm for _, arm, _ in runs[start:start + 3]), ['A', 'B', 'C'])
            self.assertEqual(len({repeat for _, _, repeat in runs[start:start + 3]}), 1)

    def replay(self, folder, extra, unaccounted=()):
        """driver.main with a fake run of $6; the provider key on standard input. Returns the runs launched, their keys and the output."""
        launched, keys = [], []

        def execute(source, arm, repeat, run_id, args, server, prompts):
            launched.append(run_id)
            keys.append(server.key)
            return {'run_id': run_id, 'source': source['key'][:8], 'kind': source['kind'], 'arm': arm, 'repeat': repeat, 'state': 'done', 'calls': 2,
                    'hermes_calls': 2, 'notes_changed': True, 'memory_ops': {}, 'cost': 6.0, 'call_detail': [],
                    'unaccounted': 'usage_unknown' if len(launched) in unaccounted else None}
        argv = ['--sources', str(folder / 'sources.jsonl'), '--profile', str(folder / 'template'), '--context-length', '1000', '--repeats', '1',
                '--broker', 'http://127.0.0.1:0', '--out', str(folder / 'out'), '--turn-home', str(folder / 'turn'), '--user-home', str(folder / 'user'), *extra]
        with mock.patch.object(driver, 'execute', execute), mock.patch.dict(os.environ), mock.patch('sys.stdin', io.StringIO(PROVIDER_KEY + '\n')), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            os.environ.pop('REPLAY_PROVIDER_KEY', None)
            driver.main(argv)
        return launched, keys, printed.getvalue()

    def test_stops_launching_runs_at_the_budget_and_resumes_within_it(self):
        self.assertFalse(driver.over_budget(0, [], 15))
        self.assertTrue(driver.over_budget(12, [6, 6], 15))
        self.assertTrue(driver.over_budget(15, [], 15))
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            sources(folder, 3), template(folder)
            launched, keys, printed = self.replay(folder, [])
            self.assertEqual(([run[:4] for run in launched], keys), (['0001', '0002'], [PROVIDER_KEY] * 2))
            self.assertIn('budget: stopped before run 3 of 9 at $12.00', printed)
            self.assertIn('spent: $12.00 over 2 runs', printed)
            # The cap holds across invocations: a second one in the same folder needs --resume, skips the recorded runs and
            # counts their cost.
            with self.assertRaises(SystemExit): self.replay(folder, [])
            with self.assertRaises(SystemExit): self.replay(folder, ['--resume', '--seed', '9'])
            launched, _, printed = self.replay(folder, ['--resume', '--budget-dollars', '24'])
            self.assertEqual([run[:4] for run in launched], ['0003', '0004'])
            self.assertIn('budget: stopped before run 5 of 9 at $24.00', printed)
            self.assertEqual(len(driver.load(folder / 'out' / 'results.jsonl')), 4)

    def test_stops_when_a_run_cost_is_not_known(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            sources(folder, 3), template(folder)
            launched, _, printed = self.replay(folder, [], unaccounted={1})
            self.assertEqual(len(launched), 1)
            self.assertIn('its cost is not fully known (usage_unknown)', printed)
        billed = {'kind': 'call', 'status': 200, 'stop': 'end_turn', 'usage': {'input': 1}}
        self.assertIsNone(driver.unaccounted([billed, {'kind': 'call', 'status': 529}, {'kind': 'other', 'status': 404}], True))
        self.assertEqual(driver.unaccounted([billed], False), 'call_in_flight')
        self.assertEqual(driver.unaccounted([{**billed, 'usage_missing': True}], True), 'usage_unknown')
        self.assertEqual(driver.unaccounted([{'kind': 'call', 'status': 200, 'parse_error': True}], True), 'usage_unknown')

    def test_arm_d_widens_only_the_review_budget(self):
        import agent.background_review as native
        seen = []
        with mock.patch.object(native, 'spawn_background_review_thread', lambda *args, **kwargs: seen.append((args, kwargs))):
            exec(driver.WIDE.replace('turn.main()', 'None'), {})
            native.spawn_background_review_thread('agent', [], review_memory=True, task_cfg={'enabled': True, 'max_input_tokens': 24000}, explicit=True)
        self.assertEqual(seen, [(('agent', []), {'review_memory': True, 'task_cfg': {'enabled': True, 'max_input_tokens': driver.WIDE_BUDGET}, 'explicit': True})])
        self.assertEqual(driver.COMMANDS['D'], ['-c', driver.WIDE])

    def test_reports_failed_runs_operations_and_prompt_size(self):
        def row(arm, state, changed, ops, calls):
            detail = [{'kind': 'call', 'status': 200, 'stop': 'tool_use', 'usage': {'input': 50, 'cache_read': 9000, 'cache_write': 950}}] * calls
            return {'source': 'aaaaaaaa', 'kind': 'i', 'arm': arm, 'repeat': 1, 'calls': calls, 'hermes_calls': calls, 'notes_changed': changed,
                    'state': state, 'failure_reason': None if state == 'done' else 'pending_tool_result', 'cost': 0.01, 'memory_ops': ops,
                    'call_detail': detail + [{'kind': 'call', 'status': 529}]}
        stats = driver.analyze([row('B', 'failed', False, {'patch:memory': 3, 'add:memory': 1}, 3), row('C', 'failed', True, {}, 3),
                                row('D', 'done', True, {'replace:memory': 1, 'add:memory': 1}, 4)], seed=1, resamples=100)
        self.assertEqual(stats['arms']['B']['failure_reasons'], {'pending_tool_result': 1})
        self.assertEqual(stats['arms']['C']['failure_reasons'], {'pending_tool_result:notes changed': 1})
        self.assertEqual((stats['arms']['B']['operations'], stats['arms']['B']['replace']), ({'patch': 3, 'add': 1}, 3))
        self.assertEqual(stats['arms']['D']['prompt_per_call'], 10000)
        self.assertEqual(stats['paired']['D-B failed_share']['difference'], -1.0)
        text = driver.report(stats)
        self.assertIn('B failed runs: pending_tool_result x1', text)
        self.assertIn('D failed runs: none', text)
        self.assertIn('D operations asked: add x1, replace x1', text)
        self.assertIn('D prompt tokens per call: 10000', text)

    def test_metrics_use_the_hermes_call_count(self):
        def row(arm, calls, hermes, thinking):
            return {'source': 'aaaaaaaa', 'kind': 'i', 'arm': arm, 'repeat': 1, 'calls': calls, 'hermes_calls': hermes, 'notes_changed': False,
                    'state': 'done', 'cost': 0.01, 'memory_ops': {}, 'call_detail': [{'kind': 'call', 'thinking': thinking}] * calls}
        # A: one loop iteration whose call was retried after an error in its stream, which the relay saw as two calls.
        stats = driver.analyze([row('A', 2, 1, None), row('C', 2, 2, 'between_tools')], seed=1, resamples=100)
        self.assertEqual((stats['arms']['A']['multi_call_share'], stats['arms']['A']['counts_differ']), (0.0, 1))
        self.assertEqual(stats['paired']['C-A multi_call_share']['difference'], 1.0)
        self.assertEqual(driver.model_calls({'calls': 3, 'hermes_calls': None}), 3)
        text = driver.report(stats)
        self.assertIn('A thinking sent: none x2', text)
        self.assertIn('C thinking sent: between_tools x2', text)

    def test_paired_bootstrap_and_agreement(self):
        rows = []
        for n, (a, b) in enumerate([((3, 1), (1, 1)), ((1, 1), (1, 1)), ((2, 3), (1, 1)), ((1, 1), (3, 3))]):
            for arm, values in (('A', a), ('B', b)):
                for repeat, calls in enumerate(values, 1):
                    rows.append({'source': f'{n:08x}', 'kind': 'i', 'arm': arm, 'repeat': repeat, 'calls': calls, 'notes_changed': calls >= 2,
                                 'state': 'done', 'cost': 0.01, 'memory_ops': {'add:memory': 1} if calls >= 2 else {}})
        stats = driver.analyze(rows, seed=1, resamples=2000)
        paired = stats['paired']['B-A multi_call_share']
        # Per source, B minus A: -0.5, 0, -1, +1.
        self.assertAlmostEqual(paired['difference'], -0.125)
        self.assertEqual(paired['sources'], 4)
        self.assertTrue(-1 <= paired['ci95'][0] <= paired['ci90'][0] <= paired['difference'] <= paired['ci90'][1] <= paired['ci95'][1] <= 1)
        self.assertEqual(paired, driver.analyze(rows, seed=1, resamples=2000)['paired']['B-A multi_call_share'])
        # A's two repeats agree for three sources of four; across arms 2 + 4 + 0 + 0 of 16 pairs agree.
        self.assertEqual(stats['agreement']['A-vs-A notes changed'], {'pairs': 4, 'agreement': 0.75})
        self.assertEqual(stats['agreement']['B-vs-A notes changed'], {'pairs': 16, 'agreement': 0.375})
        self.assertEqual(stats['arms']['A']['add'], 3)
        self.assertIn('A i', driver.report(stats))


class Relay(unittest.TestCase):
    def test_parses_both_routes_streamed_and_whole(self):
        streamed = relay.response_metrics('messages', True, anthropic_stream('m', False))
        self.assertEqual((streamed['stop'], streamed['tool_calls'], streamed['tools'], streamed['memory_ops']), ('tool_use', 1, ['memory'], [['add', 'memory']]))
        self.assertEqual(streamed['usage'], {'input': 100, 'cache_read': 0, 'cache_write': 900, 'output': 20, 'reasoning': 0})
        self.assertEqual((streamed['thinking_blocks'], streamed['thinking_chars']), (1, len('Synthetic thought.')))
        legacy = {'action': 'remove', 'target': 'user', 'old_text': 'Synthetic.'}
        chat = relay.response_metrics('chat', True, chat_stream('m', False, legacy))
        self.assertEqual((chat['stop'], chat['memory_ops'], chat['usage']['input'], chat['usage']['output']), ('tool_calls', [['remove', 'user']], 1000, 20))
        final = relay.response_metrics('chat', True, chat_stream('m', True))
        self.assertEqual((final['stop'], final['tool_calls']), ('stop', 0))
        whole = relay.response_metrics('messages', False, json.dumps({'content': [{'type': 'thinking', 'thinking': 'abc'}, {'type': 'tool_use', 'name': 'memory', 'input': ADD}],
                                                                       'stop_reason': 'tool_use', 'usage': {'input_tokens': 5, 'cache_read_input_tokens': 7, 'output_tokens': 2}}).encode())
        self.assertEqual((whole['memory_ops'], whole['thinking_blocks'], whole['usage']['cache_read']), ([['add', 'memory']], 1, 7))
        plain = relay.response_metrics('chat', False, json.dumps({'choices': [{'message': {'tool_calls': [{'function': {'name': 'memory', 'arguments': json.dumps(ADD)}}]},
                                                                               'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 9, 'prompt_tokens_details': {'cached_tokens': 4}}}).encode())
        self.assertEqual((plain['memory_ops'], plain['usage']['input'], plain['usage']['cache_read']), ([['add', 'memory']], 5, 4))
        self.assertEqual(relay.response_metrics('messages', True, b'data: {"type":"message_start","message":{"usage":{"input_tokens":"x"}}}\n\n')['usage']['input'], 0)

    def test_counts_memory_results_returned_to_the_model(self):
        over = json.dumps({'success': False, 'error': 'Applying all 3 operations would put memory at 2,300/2,200 chars: free at least 100 chars more. '
                                                      'No operations were applied (batch is all-or-nothing).'})
        miss = json.dumps({'success': False, 'error': "Operation 2 (patch): No entry matched 'synthetic'."}) + '\n\n[Tool loop warning: synthetic.]'
        staged = json.dumps({'success': True, 'staged': True, 'pending_id': 'p1'})
        applied = json.dumps({'success': True, 'message': 'Entry added.'})
        old = json.dumps({'success': False, 'error': 'Too early: answered before the last assistant message.'})
        chat = {'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': None}, {'role': 'tool', 'content': old},
                             {'role': 'assistant', 'content': None}, {'role': 'tool', 'content': over}, {'role': 'tool', 'content': applied}]}
        self.assertEqual(relay.tool_outcomes('chat', chat), {'refused:over_limit:batch': 1, 'applied': 1})
        messages = {'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'a'}]},
                                 {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'a', 'content': miss},
                                                              {'type': 'tool_result', 'tool_use_id': 'b', 'content': [{'type': 'text', 'text': staged}]},
                                                              {'type': 'text', 'text': 'not a result'}]}]}
        self.assertEqual(relay.tool_outcomes('messages', messages), {'refused:no_match': 1, 'staged': 1})
        self.assertEqual(relay.tool_outcomes('messages', {'messages': [{'role': 'user', 'content': 'first turn'}]}), {})
        self.assertEqual([relay.outcome(text) for text in ('not json', '[]', json.dumps({'success': False, 'done': True,
                          'error': 'Memory consolidation failed 4 times this turn. Stop retrying memory calls.'}),
                          json.dumps({'success': False, 'error': "'replace' is not available; use 'patch'. Nothing was written."}), None)],
                         ['other', 'other', 'refused:retry_cap', 'refused:replace_removed', 'other'])

    def test_an_error_inside_a_200_stream_is_no_completed_call(self):
        raw = anthropic_stream('m', False)
        metrics = relay.response_metrics('messages', True, anthropic_stream('m', False, error=True))
        self.assertEqual((metrics['stream_error'], metrics['stop'], metrics['usage']['input']), ('overloaded_error', None, 100))
        self.assertNotIn('usage_missing', metrics)
        self.assertFalse(driver.completed({'kind': 'call', 'status': 200, **metrics}))
        self.assertTrue(driver.completed({'kind': 'call', 'status': 200, **relay.response_metrics('messages', True, raw)}))
        chat = chat_stream('m', False).split(b'data: ')[1]
        chat = b'data: ' + chat + b'data: ' + json.dumps(OVERLOADED).encode() + b'\n\n'
        metrics = relay.response_metrics('chat', True, chat)
        self.assertEqual((metrics['stream_error'], metrics['usage_missing']), ('overloaded_error', True))
        self.assertFalse(driver.completed({'kind': 'call', 'status': 200, **metrics}))

    def test_waits_for_a_call_still_in_flight(self):
        server = relay.Relay(port=0)
        self.addCleanup(server.server_close)
        server.inflight['r1'] += 1

        def finish():
            with server.lock:
                server.inflight['r1'] -= 1
                server.settled.notify_all()
        self.assertFalse(server.settle('r1', 0.05))
        threading.Timer(0.2, finish).start()
        self.assertTrue(server.settle('r1', 10))
        self.assertTrue(server.settle('other', 0))

    def test_broker_request_policy(self):
        mixed = {'model': 'm', 'messages': [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': [
            {'type': 'thinking', 'thinking': 't', 'signature': 's'}, {'type': 'tool_use', 'id': 'x', 'name': 'memory', 'input': {'url': 'kept'}}]}]}
        self.assertEqual(relay.anthropic_payload(mixed)['messages'][1]['content'], [mixed['messages'][1]['content'][1]])
        for refused, code in (({**mixed, 'betas': []}, 'provider_request_field_denied'), ({**mixed, 'tools': [{'type': 'web_search_20250305', 'name': 'w'}]}, 'hosted_provider_tools_denied'),
                              ({**mixed, 'metadata': {'container': 'c'}}, 'opaque_provider_context_denied')):
            with self.assertRaises(relay.Refused) as caught: relay.anthropic_payload(refused)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(relay.Refused) as caught: relay.provider_payload({'model': 'm', 'messages': [], 'tools': [{'type': 'web_search'}]})
        self.assertEqual(caught.exception.code, 'hosted_provider_tools_denied')
        evidence = relay.EVIDENCE + '{}'
        self.assertEqual(relay.evidence_position({'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': evidence}, {'type': 'text', 'text': 'q'}]}]}), 'first_block')
        self.assertEqual(relay.evidence_position({'messages': [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': evidence}]}), 'separate_message')
        self.assertEqual(relay.evidence_position({'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'q'}, {'type': 'text', 'text': evidence}]}]}), 'other')
        self.assertEqual(relay.evidence_position({'messages': [{'role': 'user', 'content': 'q'}]}), 'absent')

    def test_mirrors_the_broker_constants(self):
        from services.hermes.memory_evidence import PREFIX
        self.assertEqual(relay.EVIDENCE, PREFIX)
        broker = (driver.ROOT / 'src' / 'security' / 'broker.ts').read_text()
        policy = (driver.ROOT / 'src' / 'security' / 'provider-request.ts').read_text()
        listed = lambda text, name: set(re.findall(r"'([^']+)'", re.search(name + r'=new Set\(\[([^\]]*)\]', text).group(1)))
        self.assertIn(f"ANTHROPIC_VERSION='{relay.ANTHROPIC_VERSION}'", broker)
        self.assertEqual(listed(broker, 'ANTHROPIC_BETAS'), set(relay.ANTHROPIC_BETAS))
        self.assertEqual(listed(policy, 'ANTHROPIC_FIELDS'), relay.ANTHROPIC_FIELDS)
        self.assertEqual(listed(policy, 'ANTHROPIC_TOOL_FIELDS'), relay.ANTHROPIC_TOOL_FIELDS)
        self.assertEqual(listed(policy, 'ANTHROPIC_BLOCKS'), relay.ANTHROPIC_BLOCKS)

    def test_passes_guarded_copies_through_and_logs_counts_only(self):
        upstream = provider()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as name:
            log = Path(name) / 'calls.jsonl'
            server = relay.start(port=0, log=str(log), upstream='http://127.0.0.1:%d' % upstream.server_address[1], key=PROVIDER_KEY, model='m')
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            base = 'http://127.0.0.1:%d' % server.server_address[1]

            def post(path, body, headers=None):
                request = urllib.request.Request(base + path, data=json.dumps(body).encode(), method='POST',
                                                 headers={'Content-Type': 'application/json', **(headers or {'Authorization': 'Bearer turn.replay.t1'})})
                try:
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response: return response.status, json.loads(response.read())
                except urllib.error.HTTPError as error:
                    with error: return error.code, json.loads(error.read())
            payload = {'messages': [{'role': 'user', 'content': SOURCE_TEXT}]}
            self.assertEqual(post('/v1/guard', {'destination': 'http://nocheh-security:8786/v1/chat/completions', 'payload': payload}), (200, {'guarded': True, 'payload': payload}))
            # Live, the turn's network reaches nothing but the broker; here the guard refuses any other destination.
            for elsewhere in ('https://elsewhere.invalid/v1/messages?key=' + KEY, 'http://nocheh-security:9999/v1/guard', None):
                self.assertEqual(post('/v1/guard', {'destination': elsewhere, 'payload': payload}), (403, {'error': 'replay_destination_denied'}))
            self.assertEqual(post('/v1/context/prepare', [SOURCE_TEXT, {'text': NOTE}]), (200, [SOURCE_TEXT, {'text': NOTE}]))
            self.assertEqual(post('/v1/guard', {'payload': payload}, {'Authorization': 'Bearer scope.other'})[0], 401)
            self.assertEqual(post('/v1/unknown?value=' + KEY, {}), (404, {'error': 'not_found'}))
            self.assertEqual(post('/v1/chat/completions', {'model': 'other', 'messages': []})[1], {'error': 'model_configuration_mismatch'})
            upstream.fail = 529
            status, body = post('/anthropic/v1/messages', {'model': 'm', 'max_tokens': 5, 'messages': [{'role': 'user', 'content': SOURCE_TEXT}]},
                                {'x-api-key': 'turn.replay.t1', 'anthropic-beta': 'interleaved-thinking-2025-05-14,files-api-2025-04-14'})
            self.assertEqual((status, body), (503, {'error': 'provider_request_failed', 'provider_status': 529}))
            self.assertEqual(upstream.seen[-1]['headers']['anthropic-beta'], 'interleaved-thinking-2025-05-14')
            self.assertEqual(upstream.seen[-1]['headers']['anthropic-version'], relay.ANTHROPIC_VERSION)
            entries = driver.load(log)
            self.assertEqual([(e['kind'], e['status']) for e in entries], [('other', 403)] * 3 + [('other', 401), ('other', 404), ('call', 403), ('call', 529)])
            self.assertEqual([e['host'] for e in entries[:3]], ['elsewhere.invalid', 'nocheh-security', None])
            self.assertEqual(entries[4]['path'], '/v1/unknown')
            self.assertEqual((entries[5]['evidence'], entries[6]['error_type'], entries[6]['evidence']), ('absent', 'overloaded_error', 'no_guard_call'))
            text = log.read_text()
            for secret in (SOURCE_TEXT, NOTE, KEY, PROVIDER_KEY, 'Synthetic upstream detail', 'turn.replay'):
                self.assertNotIn(secret, text)


if __name__ == '__main__':
    unittest.main()
