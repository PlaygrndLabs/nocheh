"""Side-by-side replay of Nocheh's memory-notes reviews on three model routes (README.md).

Each run is the live review subprocess, services.hermes.assistant_turn, with the body that
services/hermes/review_worker.py _review builds in isolated mode (plus the model_context_length the
security launcher adds), on a fresh copy of a profile template, against the relay in this folder.
The arms use the same model, inputs and Hermes and differ only in the route:
A Anthropic's OpenAI-compatible chat API (the route before prompt caching), B its Messages API as
live, C as B with assistant_turn.reasoning returning {'enabled': False}. For claude-sonnet-5-5 Hermes
then sends thinking {type: between_tools} (agent/anthropic_adapter.py _thinking_kwargs): no thinking
up front, but notes between tool calls still allowed, where B sends no thinking field and gets the
API's default adaptive thinking. C is not "thinking off". Every run sees the live paths, HERMES_HOME
/profile and HOME /tmp/home, so no run, arm or repeat shows in what the model is sent. Results hold
counts only.
"""
import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

try:
    from . import relay
except ImportError:  # run as a script: python /replay/driver.py
    import relay

import services.hermes

ROOT = Path(services.hermes.__file__).resolve().parents[2]
ARMS = ('A', 'B', 'C')
KINDS = ('i', 'ii', 'iii')
# Dollars per million tokens.
PRICES = {'input': 2.0, 'output': 10.0, 'cache_read': 0.20, 'cache_write': 2.50}
TOKENS = ('input', 'cache_read', 'cache_write', 'output', 'reasoning')
# Hermes tools/memory_tool_store.py ENTRY_DELIMITER.
ENTRY_DELIMITER = '\n§\n'
NOTES = ('MEMORY.md', 'USER.md')
# A review's chat and user are the owner's ID. No request or note carries it, so a synthetic one stands in.
OWNER = '1000000001'
# Arm C: the live subprocess, with assistant_turn.reasoning returning {'enabled': False} (thinking between_tools, see above).
THINKING_OFF = "import services.hermes.assistant_turn as turn;turn.reasoning=lambda credentials,prefs:{'enabled':False};turn.main()"
# Run state a fresh profile does not have; the policy file stays in the template, which is the policy root.
RUN_STATE = {'native-state', 'sessions', 'reviews', 'pending', 'plugins', 'state.db', '.memory.lock', '.turn.lock', '.foreground', 'nocheh-policy.yaml'}
# The image's own environment, which the live turn container inherits besides the variables the launcher sets.
IMAGE_ENV = ('PATH', 'LANG', 'LD_LIBRARY_PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED')
# security_launcher.container_spec: HERMES_HOME=/profile (a tmpfs) and HOME=/tmp/home. Hermes writes both into the system
# prompt, so every run uses them; a home under a profiles/ folder would also turn the default profile's paragraph into a
# named profile's.
TURN_HOME, USER_HOME = '/profile', '/tmp/home'
# Longest wait for a run's model call still being read after its process ended (the relay reads for up to 120 s at a time).
SETTLE_SECONDS = 130


def private_file(path):
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
    os.chmod(path, 0o600)
    return path


def append(path, record):
    with open(path, 'a', encoding='utf-8') as file: file.write(json.dumps(record, separators=(',', ':')) + '\n')


def load_sources(path):
    sources = []
    for number, line in enumerate(Path(path).read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip(): continue
        row = json.loads(line)
        hexes = all(isinstance(row.get(key), str) and len(row[key]) == 64 and set(row[key]) <= set('0123456789abcdef') for key in ('key', 'event_id'))
        if not (hexes and row.get('kind') in KINDS and isinstance(row.get('text'), str) and 0 < len(row['text']) <= 12000):
            # The line number only: never the text.
            raise SystemExit(f'sources line {number}: needs key and event_id (64 hex), kind i|ii|iii and text of 1-12,000 characters')
        sources.append(row)
    return sources


def schedule(sources, arms, repeats, seed):
    """Runs in a seeded order: sources shuffled, and within each source every repeat runs each arm once in shuffled order."""
    rng = random.Random(seed)
    order = list(sources)
    rng.shuffle(order)
    runs = []
    for source in order:
        for repeat in range(1, repeats + 1):
            block = list(arms)
            rng.shuffle(block)
            runs += [(source, arm, repeat) for arm in block]
    return runs


def entries(raw):
    # MemoryStore._parse: stripped, non-empty entries.
    return [entry for entry in (part.strip() for part in raw.split(ENTRY_DELIMITER)) if entry]


def drop_entries(memories, event_id):
    """Remove whole note entries that cite the source event, so the run starts as the original review did."""
    marker, dropped = 'nocheh:event:' + event_id, 0
    for name in NOTES:
        path = memories / name
        if not path.is_file(): continue
        parts = path.read_text(encoding='utf-8').split(ENTRY_DELIMITER)
        kept = [part for part in parts if marker not in part]
        if len(kept) != len(parts):
            path.write_text(ENTRY_DELIMITER.join(kept), encoding='utf-8')
            dropped += len(parts) - len(kept)
    return dropped


def notes(home):
    from services.hermes.native_memory import notes_snapshot
    return notes_snapshot(home)


def counts(snapshot):
    return {name: None if raw is None else len(entries(raw.decode('utf-8', 'replace'))) for name, raw in zip(NOTES, snapshot)}


def wipe(home, user):
    """Empty the turn home (it may be a tmpfs mount point, so the folder stays) and remove the user home, which the
    launcher does not make in advance."""
    for item in list(home.iterdir()) if home.is_dir() and not home.is_symlink() else ():
        if item.is_dir() and not item.is_symlink(): shutil.rmtree(item)
        else: item.unlink()
    shutil.rmtree(user, ignore_errors=True)


def prepare_home(template, home, event_id):
    """The template copied into the empty turn home, less the entries citing the source, prepared and with the
    preferences review_worker._review computes. The template is the policy root (it holds nocheh-policy.yaml), as
    NOCHEH_RUNTIME_HOME names the state root live (native_admin.py); live, the turn sees no policy file either."""
    from services.hermes.isolated_profile import prepare
    from services.hermes.profile_config import inherited_config, preferences, read
    shutil.copytree(template, home, dirs_exist_ok=True, ignore=lambda folder, names: [n for n in names if Path(folder) == template and n in RUN_STATE])
    # The copy is the operator's alone whatever the template's modes; what the review writes follows the umask, 077.
    for path in [home, *home.rglob('*')]:
        if not path.is_symlink(): path.chmod(0o700 if path.is_dir() else 0o600)
    dropped = drop_entries(home / 'memories', event_id)
    prepare(home)
    prior = os.environ.get('NOCHEH_RUNTIME_HOME')
    os.environ['NOCHEH_RUNTIME_HOME'] = str(template)
    try: effective, _ = inherited_config(home, read(home / 'config.yaml'))
    finally:
        if prior is None: del os.environ['NOCHEH_RUNTIME_HOME']
        else: os.environ['NOCHEH_RUNTIME_HOME'] = prior
    return preferences(effective), dropped


def review_body(source, arm, run_id, args, prefs, prompts):
    from services.hermes.security_transport import BROKER, scoped_transport
    credential = 'turn.replay.' + run_id
    # The model routes keep the broker's own address, the only one SubscriptionCredentials accepts; the container's
    # --add-host points it at the relay. Arm A is set directly: scoped_transport would turn it into the Messages API.
    transport = (dict(api_key=credential, base_url=BROKER + '/v1', provider='openai', api_mode='chat_completions') if arm == 'A'
                 else scoped_transport(credential, 'anthropic_messages'))
    return {'review': True, 'review_id': source['key'], 'text': source['text'], 'model': args.model, 'archive_credential': credential,
            'memory_context': args.memory_context, 'session_id': 'review-' + source['key'], 'prompts': prompts, 'owner': True,
            'chat_id': OWNER, 'user_id': OWNER, **transport, 'preferences': prefs, 'model_context_length': args.context_length}


def run_env(home, user, broker):
    env = {key: os.environ[key] for key in IMAGE_ENV if key in os.environ}
    path = [part for part in os.environ.get('PYTHONPATH', '').split(os.pathsep) if part]
    env.update(HERMES_HOME=str(home), HOME=str(user), GUARD_MODE='on', NOCHEH_ISOLATED_TURN='1', GUARD_URL=broker, ARCHIVE_URL=broker,
               PYTHONPATH=os.pathsep.join(path if str(ROOT) in path else path + [str(ROOT)]))
    env.setdefault('LANG', 'C.UTF-8')
    return env


def cost(usage):
    return sum(usage.get(key, 0) * price for key, price in PRICES.items()) / 1e6


def completed(call):
    """A model call that returned a whole response: 200, parsed, with a stop reason and no error event in its stream."""
    return call.get('kind') == 'call' and call.get('status') == 200 and call.get('stop') is not None and not call.get('parse_error') \
        and not call.get('stream_error')


def unaccounted(calls, settled):
    """Why a run's cost is not fully known, or None: a call still read from the provider after the wait, or one that
    answered 200 without a usage the relay could read. The driver then launches no more runs."""
    if not settled: return 'call_in_flight'
    if any(call.get('kind') == 'call' and call.get('status') == 200 and (call.get('parse_error') or call.get('usage_missing')) for call in calls):
        return 'usage_unknown'
    return None


def execute(source, arm, repeat, run_id, args, server, prompts):
    """One review run in the emptied turn home; returns its record of counts."""
    started, home, user = time.monotonic(), Path(args.turn_home), Path(args.user_home)
    result = {}
    try:
        wipe(home, user)
        prefs, dropped = prepare_home(Path(args.profile), home, source['event_id'])
        before = notes(home)
        command = [sys.executable, '-c', THINKING_OFF] if arm == 'C' else [sys.executable, '-m', 'services.hermes.assistant_turn']
        try:
            done = subprocess.run(command, input=json.dumps(review_body(source, arm, run_id, args, prefs, prompts)).encode(), stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=run_env(home, user, args.broker), timeout=220, cwd=ROOT)
            lines = [line for line in done.stdout.decode('utf-8', 'replace').splitlines() if line.strip()]
            try: result = json.loads(lines[-1]) if lines else {}
            except ValueError: result = {}
            result = result if isinstance(result, dict) else {}
            state = relay.name(result.get('state')) or 'no_result'
        except subprocess.TimeoutExpired:
            state = 'timed_out'
            # A call the killed process had just sent reaches the relay a moment later.
            time.sleep(1)
        after, staged = notes(home), len(list((home / 'pending' / 'memory').glob('*.json')))
        if args.keep_homes: shutil.copytree(home, Path(args.out) / 'homes' / run_id, symlinks=True)
    finally:
        wipe(home, user)
    settled = server.settle(run_id, SETTLE_SECONDS)
    calls = server.take(run_id)
    route = 'chat' if arm == 'A' else 'messages'
    model = [call for call in calls if call.get('kind') == 'call']
    answered = [call for call in model if completed(call)]
    usage = {key: sum((call.get('usage') or {}).get(key, 0) for call in model) for key in TOKENS}
    record = {'run_id': run_id, 'source': source['key'][:8], 'kind': source['kind'], 'arm': arm, 'repeat': repeat, 'state': state,
              **{key: relay.name(result.get(key)) for key in ('failure_reason', 'failure_cause', 'error_code')},
              # Completed calls on the arm's route, as the relay saw them; the metrics use Hermes's own count (hermes_calls).
              'calls': sum(call['route'] == route for call in answered), 'failed_calls': len(model) - len(answered),
              'stream_errors': sum(bool(call.get('stream_error')) for call in model),
              'other_route_calls': sum(call['route'] != route for call in answered),
              'hermes_calls': result['usage'].get('calls') if isinstance(result.get('usage'), dict) else None,
              'call_detail': [{key: value for key, value in call.items() if key != 'run_id'} for call in calls],
              'memory_ops': dict(Counter(f'{action}:{target}' for call in answered for action, target in call.get('memory_ops') or [])),
              'notes_before': counts(before), 'notes_after': counts(after), 'dropped_entries': dropped,
              'memory_changed': before[0] != after[0], 'user_changed': before[1] != after[1], 'notes_changed': before != after,
              'staged': staged, 'tokens': usage, 'cost': round(cost(usage), 6), 'unaccounted': unaccounted(calls, settled),
              'seconds': round(time.monotonic() - started, 1)}
    return record


def over_budget(spent, costs, budget):
    """Whether another run could pass the budget: the spend so far plus the mean cost of a run so far."""
    return spent >= budget or bool(costs) and spent + sum(costs) / len(costs) > budget


def load(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]


def actions(rows):
    total = Counter()
    for row in rows:
        for key, count in (row.get('memory_ops') or {}).items(): total[key.split(':', 1)[0]] += count
    return {'add': total['add'], 'replace': total['replace'] + total['patch'], 'remove': total['remove']}


def model_calls(row):
    """A run's model calls as live counts them: Hermes's api_calls (review_worker records usage.combine(RUNS)), one per
    loop iteration however often the call was retried; the relay's count of completed calls only when Hermes gave none."""
    return row['hermes_calls'] if type(row.get('hermes_calls')) is int else row['calls']


def group(rows):
    runs = len(rows)
    return {'runs': runs, 'multi_call_share': sum(model_calls(r) >= 2 for r in rows) / runs, 'mean_calls': sum(model_calls(r) for r in rows) / runs,
            'notes_changed_share': sum(r['notes_changed'] for r in rows) / runs, **actions(rows),
            'failures': sum(r['state'] != 'done' for r in rows),
            # Runs where the relay's completed calls and Hermes's count differ, such as a retry after an error in a stream.
            'counts_differ': sum(type(r.get('hermes_calls')) is int and r['hermes_calls'] != r['calls'] for r in rows),
            'cost': round(sum(r['cost'] for r in rows), 4),
            'thinking': dict(Counter(call.get('thinking') or 'none' for r in rows for call in r.get('call_detail') or [] if call.get('kind') == 'call'))}


METRICS = {'multi_call_share': lambda r: model_calls(r) >= 2, 'notes_changed_share': lambda r: r['notes_changed']}


def by_source(rows, arm, metric):
    """Each source's mean over its repeats."""
    values = {}
    for row in rows:
        if row['arm'] == arm: values.setdefault(row['source'], []).append(float(METRICS[metric](row)))
    return {source: sum(found) / len(found) for source, found in values.items()}


def bootstrap(diffs, seed, resamples=10000):
    """Paired differences over sources: their mean and percentile intervals from seeded resamples of the sources."""
    if not diffs: return None
    rng, n = random.Random(seed), len(diffs)
    means = sorted(sum(rng.choices(diffs, k=n)) / n for _ in range(resamples))
    at = lambda share: means[min(resamples - 1, int(share * resamples))]
    return {'difference': sum(diffs) / n, 'sources': n, 'ci90': [at(0.05), at(0.95)], 'ci95': [at(0.025), at(0.975)]}


def agreement(rows, first, second):
    """How often two runs of one source agree on whether the notes changed: repeat pairs of one arm, or every pair across two."""
    found = {}
    for row in rows: found.setdefault((row['source'], row['arm']), []).append(bool(row['notes_changed']))
    pairs = agree = 0
    for (source, arm), left in found.items():
        if arm != first or (source, second) not in found: continue
        right = found[(source, second)]
        combos = [(left[i], left[j]) for i in range(len(left)) for j in range(i + 1, len(left))] if first == second else [(a, b) for a in left for b in right]
        pairs += len(combos)
        agree += sum(a == b for a, b in combos)
    return {'pairs': pairs, 'agreement': agree / pairs if pairs else None}


def analyze(rows, seed=0, resamples=10000):
    arms = sorted({row['arm'] for row in rows})
    stats = {'arms': {arm: group([r for r in rows if r['arm'] == arm]) for arm in arms},
             'arm_kind': {f'{arm} {kind}': group(found) for arm in arms for kind in KINDS
                          if (found := [r for r in rows if r['arm'] == arm and r['kind'] == kind])},
             'paired': {}, 'agreement': {}}
    for arm in ('B', 'C'):
        if arm not in arms or 'A' not in arms: continue
        for metric in METRICS:
            base, other = by_source(rows, 'A', metric), by_source(rows, arm, metric)
            stats['paired'][f'{arm}-A {metric}'] = bootstrap([other[s] - base[s] for s in sorted(base) if s in other], seed, resamples)
    for first, second in (('A', 'A'), ('B', 'A'), ('C', 'A')):
        if first in arms and second in arms: stats['agreement'][f'{first}-vs-{second} notes changed'] = agreement(rows, first, second)
    return stats


COLUMNS = {'runs': 'runs', 'multi_call_share': '2+calls', 'mean_calls': 'calls', 'notes_changed_share': 'changed', 'add': 'adds',
           'replace': 'replaces', 'remove': 'removes', 'failures': 'failed', 'counts_differ': 'differ', 'cost': 'dollars'}


def report(stats):
    cell = lambda value: '-' if value is None else f'{value:.3f}' if isinstance(value, float) else str(value)
    lines = ['arm kind ' + ''.join(f'{label:>9}' for label in COLUMNS.values())]
    for title in ('arms', 'arm_kind'):
        lines += [f'{name:<8} ' + ''.join(f'{cell(row[column]):>9}' for column in COLUMNS) for name, row in stats[title].items()]
    lines.append('calls are Hermes\'s own count; differ: runs where the relay counted other completed calls')
    for name, row in stats['arms'].items():
        lines.append(f'{name} thinking sent: ' + (', '.join(f'{setting} x{count}' for setting, count in sorted(row['thinking'].items())) or 'no calls'))
    lines.append(f"spent: ${sum(row['cost'] for row in stats['arms'].values()):.2f} over {sum(row['runs'] for row in stats['arms'].values())} runs")
    for name, value in stats['paired'].items():
        lines.append(f'{name}: ' + ('no paired sources' if value is None else
                     f"{value['difference']:+.3f} over {value['sources']} sources, 90% [{value['ci90'][0]:+.3f}, {value['ci90'][1]:+.3f}], "
                     f"95% [{value['ci95'][0]:+.3f}, {value['ci95'][1]:+.3f}]"))
    for name, value in stats['agreement'].items():
        lines.append(f"{name}: {cell(value['agreement'])} of {value['pairs']} pairs")
    return '\n'.join(lines)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--sources', help='JSON lines: key (64-hex review id), event_id, kind i|ii|iii, text')
    parser.add_argument('--profile', help='Profile template: config.yaml, memories/MEMORY.md and USER.md, optional nocheh-policy.yaml')
    parser.add_argument('--prompts', help="JSON object of the owner's replacement texts (default {})")
    parser.add_argument('--model', default='claude-sonnet-5-5')
    parser.add_argument('--context-length', type=int, help="The reply model's context length the launcher sends")
    parser.add_argument('--memory-context', choices=('evidence', 'legacy'), default=os.environ.get('NOCHEH_MEMORY_CONTEXT') or 'evidence')
    parser.add_argument('--arms', default='A,B,C')
    parser.add_argument('--repeats', type=int, default=2)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--budget-dollars', type=float, default=15.0)
    parser.add_argument('--broker', default='http://nocheh-security:8786', help='Where the relay listens, on 127.0.0.1 at this port')
    parser.add_argument('--out', help='New folder for results.jsonl and calls.jsonl')
    parser.add_argument('--resume', action='store_true', help='Continue in an --out that holds results, with the same arguments: '
                        'runs already recorded are skipped and their cost counts toward the budget')
    parser.add_argument('--keep-homes', action='store_true', help="Keep a copy of each run's profile after the run in <out>/homes (they hold the owner's notes)")
    parser.add_argument('--turn-home', default=TURN_HOME, help='HERMES_HOME of every run: the live path; another only for tests')
    parser.add_argument('--user-home', default=USER_HOME, help='HOME of every run: the live path; another only for tests')
    parser.add_argument('--smoke', action='store_true', help='First source only, one repeat, all arms, with each provider call printed')
    parser.add_argument('--analyze', metavar='FILE', help='Print the summary and statistics of a results file')
    args = parser.parse_args(argv)
    if args.analyze: return args
    if not all((args.sources, args.profile, args.out)) or args.context_length is None or args.context_length < 1:
        parser.error('--sources, --profile, --context-length and --out are required')
    args.arms = [arm.strip() for arm in args.arms.split(',') if arm.strip()]
    if not args.arms or any(arm not in ARMS for arm in args.arms) or len(set(args.arms)) != len(args.arms): parser.error('--arms takes A, B and C')
    if args.repeats < 1: parser.error('--repeats must be at least 1')
    return args


def provider_key():
    """The provider key: one line on standard input (docker run -i), so it is in no container configuration; the
    environment only for tests and a relay run by hand."""
    key = os.environ.get('REPLAY_PROVIDER_KEY')
    if not key and sys.stdin is not None and not sys.stdin.isatty(): key = sys.stdin.readline().strip()
    if not key: raise SystemExit('the provider key goes on standard input')
    return key


def main(argv=None):
    args = arguments(argv)
    if args.analyze:
        print(report(analyze(load(args.analyze), args.seed)))
        return
    # Every folder and file of the driver and the review process, which inherits it, is the operator's own.
    mask = os.umask(0o077)
    try: replay(args)
    finally: os.umask(mask)


def replay(args):
    key = provider_key()
    if not (Path(args.profile) / 'config.yaml').is_file(): raise SystemExit('the profile template has no config.yaml')
    home, user = Path(args.turn_home), Path(args.user_home)
    # Each run empties both folders; they must hold nothing of anyone else's to begin with.
    if home.is_symlink() or home.exists() and (not home.is_dir() or any(home.iterdir())) or user.exists() and (user.is_symlink() or any(user.iterdir())):
        raise SystemExit('--turn-home must be an empty folder and --user-home empty or absent')
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    sources = load_sources(args.sources)
    prompts = json.loads(Path(args.prompts).read_text(encoding='utf-8')) if args.prompts else {}
    if not isinstance(prompts, dict): raise SystemExit('--prompts must hold a JSON object')
    prompts = {key: text for key, text in prompts.items() if isinstance(text, str)}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    results, marker = out / 'results.jsonl', out / 'replay.json'
    plan = {'sources': hashlib.sha256(Path(args.sources).read_bytes()).hexdigest(), 'arms': args.arms, 'repeats': args.repeats,
            'seed': args.seed, 'smoke': args.smoke, 'model': args.model}
    earlier = load(results) if results.is_file() else []
    if earlier and not args.resume: raise SystemExit('--out already holds results: use a new folder, or --resume with the same arguments')
    if args.resume and marker.is_file() and json.loads(marker.read_text()) != plan:
        raise SystemExit('--resume needs the sources, arms, repeats, seed and model of the first invocation')
    private_file(marker).write_text(json.dumps(plan), encoding='utf-8')
    private_file(results)
    runs = schedule(sources[:1], ARMS, 1, args.seed) if args.smoke else schedule(sources, args.arms, args.repeats, args.seed)
    port = urlsplit(args.broker).port
    server = relay.start(port=80 if port is None else port, log=private_file(out / 'calls.jsonl'), model=args.model, key=key, allowed=[args.broker])
    done = {row['run_id'] for row in earlier}
    costs = [row['cost'] + row.get('late_cost', 0) for row in earlier]
    spent = sum(costs)
    try:
        for number, (source, arm, repeat) in enumerate(runs, 1):
            run_id = f'{number:04d}-{arm}{repeat}'
            if run_id in done: continue
            # Calls recorded after their run was counted (one sent just before a timeout) are billed too.
            late = round(sum(cost(call.get('usage') or {}) for call in server.take() if call.get('kind') == 'call'), 6)
            spent += late
            if over_budget(spent, costs, args.budget_dollars):
                print(f'budget: stopped before run {number} of {len(runs)} at ${spent:.2f}')
                break
            record = execute(source, arm, repeat, run_id, args, server, prompts)
            if late: record['late_cost'] = late
            append(results, record)
            spent += record['cost']
            costs.append(record['cost'] + late)
            why = '' if record['state'] == 'done' else f" ({record.get('failure_reason') or '-'}:{record.get('failure_cause') or '-'})"
            print(f"{record['run_id']} {record['source']} {record['kind']:>3} {arm} {record['state']}{why} calls={record['hermes_calls']} "
                  f"relay={record['calls']} notes_changed={record['notes_changed']} staged={record.get('staged')} ${record['cost']:.4f} "
                  f"total ${spent:.2f}", flush=True)
            if args.smoke:
                for call in record['call_detail']:
                    print(f"   {call.get('route') or call.get('method', '') + ' ' + call.get('path', '')} {call.get('status')} "
                          f"{call.get('stream_error') or ''} {','.join(t or '-' for t in call.get('tools') or [])}")
            if record['unaccounted']:
                print(f"budget: stopped after run {run_id} at ${spent:.2f}: its cost is not fully known ({record['unaccounted']}). "
                      "Check the provider's usage page before going on with --resume.")
                break
    finally:
        server.shutdown()
        server.server_close()
        if home.is_dir() and any(home.iterdir()): print('warning: the turn home still holds a profile copy; empty it')
    rows = load(results)
    if rows: print(report(analyze(rows, args.seed)))


if __name__ == '__main__':
    main()
