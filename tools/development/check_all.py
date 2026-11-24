"""Run every test suite and say which failures are new.

    python3 -m tools.development.check_all [--setup] [--only SECTION ...] [--skip SECTION ...] [--no-build]

Sections, in this order:
  load     every tracked Python file compiles
  node     every compiled Node test file, each against a freshly reset synthetic Postgres with the storage and
           workflow fixture switches on, so the storage tests run too
  browser  the dashboard page tests in Chromium, against the same Postgres
  python   the Python unit tests of services/hermes, services/telegram, services/reader, services/honcho and test/

What it needs:
  Node 26 after `npm ci`.
  A synthetic Postgres reached through PGHOST, PGPORT, PGUSER and PGPASSWORD, started with
  `-c cluster_name=nocheh-stores-fixture`. Every database and role on it is dropped before each Node test file.
  NOCHEH_CHECK_PGPORTS="5432 5433 ..." names several such clusters on PGHOST: one worker runs on each.
  Two Python environments under data/test-env/, made by --setup with uv and git: Hermes at its pinned revision
  with Nocheh's plugins, and a small one for the Honcho plugin tests. The reader tests need ffmpeg.
  Chromium for the browser section (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or Playwright's).

A failure listed in test/known-failures.json is shown but does not fail the run. A listed test that passes now is
shown too, so it can come off the list. The run fails on any other failure. Results and logs go to
data/test-results/<time>/.
"""
from tools.paths import ROOT
from tools.development.store_tests import DATABASES, ROLES
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

SECTIONS = ('load', 'node', 'browser', 'python')
KNOWN = ROOT / 'test/known-failures.json'
ENVIRONMENTS = ROOT / 'data/test-env'
HERMES = ENVIRONMENTS / 'hermes-agent'
HERMES_PYTHON = ENVIRONMENTS / 'hermes/bin/python'
HONCHO_PYTHON = ENVIRONMENTS / 'honcho/bin/python'
# The Honcho plugin tests need Honcho's command line tool and the database library Honcho's server pins.
HONCHO_EXTRA = 'sqlalchemy==2.0.49'
REPORTER = ROOT / 'tools/development/failures-reporter.mjs'
FILE_SECONDS = 900
# The browser file opens every dashboard page; one slow page waits 30 s.
BROWSER_SECONDS = 2700
# Synthetic credentials only: these tests never see an installation's .env.
SERVICE_TOKEN = 'check-all-token-not-a-real-credential'


def say(text):
    print(text, flush=True)


def run(command, **options):
    return subprocess.run(command, cwd=ROOT, **options)


def setup():
    """Make the two Python environments the Python section uses."""
    lock = json.loads((ROOT / 'deploy/upstreams.lock.json').read_text())['hermes']
    if not (HERMES / '.git').exists() or run(['git', '-C', str(HERMES), 'rev-parse', 'HEAD'], capture_output=True,
                                              text=True).stdout.strip() != lock['revision']:
        shutil.rmtree(HERMES, ignore_errors=True)
        HERMES.mkdir(parents=True)
        for command in (['init', '-q'], ['remote', 'add', 'origin', lock['repository']],
                        ['fetch', '-q', '--depth', '1', 'origin', lock['revision']], ['checkout', '-q', 'FETCH_HEAD']):
            run(['git', '-C', str(HERMES)] + command, check=True)
    # The same extras as deploy/hermes.Dockerfile.
    environment = {**os.environ, 'UV_PROJECT_ENVIRONMENT': str(HERMES_PYTHON.parents[1])}
    run(['uv', 'sync', '--quiet', '--project', str(HERMES), '--frozen', '--no-dev', '--no-install-project', '--extra', 'messaging',
         '--extra', 'anthropic', '--extra', 'mcp', '--python', '3.14'], env=environment, check=True)
    run(['uv', 'pip', 'install', '--quiet', '--python', str(HERMES_PYTHON), '--require-hashes', '--no-deps', '-r',
         'deploy/hermes-plugin-requirements.txt'], check=True)
    if not HONCHO_PYTHON.exists():
        run(['uv', 'venv', '--quiet', '--python', '3.14', str(HONCHO_PYTHON.parents[1])], check=True)
    run(['uv', 'pip', 'install', '--quiet', '--python', str(HONCHO_PYTHON), '-r', 'services/honcho/cli/requirements.txt',
         HONCHO_EXTRA], check=True)


def ports():
    """The synthetic Postgres clusters to use: one per worker, on PGHOST, at the ports in NOCHEH_CHECK_PGPORTS."""
    if not os.environ.get('PGHOST'):
        raise SystemExit('Set PGHOST, PGPORT, PGUSER and PGPASSWORD to a synthetic Postgres (see --help).')
    return os.environ.get('NOCHEH_CHECK_PGPORTS', os.environ.get('PGPORT', '5432')).replace(',', ' ').split()


def psql(port, database, sql):
    return subprocess.check_output(['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-p', port, '-d', database, '-c', sql],
                                   text=True).strip()


def reset(port):
    """Empty one synthetic cluster, as tools/development/store_tests.py does between files."""
    if psql(port, 'postgres', "SELECT current_setting('cluster_name')") != 'nocheh-stores-fixture':
        raise SystemExit('The Postgres in PGHOST must be a synthetic one started with cluster_name=nocheh-stores-fixture.')
    for query in (DATABASES, ROLES):
        for statement in filter(None, (part.strip() for part in psql(port, 'postgres', query).split(';'))):
            psql(port, 'postgres', statement)
    psql(port, 'postgres', 'CREATE DATABASE nocheh')


def load(results, only=None):
    """Every tracked Python file compiles, with the Python the services run on when it is there."""
    python = str(HERMES_PYTHON) if HERMES_PYTHON.exists() else sys.executable
    files = run(['git', 'ls-files', '*.py'], capture_output=True, text=True, check=True).stdout.split()
    script = ('import sys\nfor name in sys.argv[1:]:\n    try: compile(open(name, "rb").read(), name, "exec")\n'
              '    except SyntaxError as error: print(name + ": " + str(error))\n')
    output = run([python, '-c', script] + files, capture_output=True, text=True).stdout
    failed = [{'test': line.split(':', 1)[0], 'error': line.split(':', 1)[1].strip()} for line in output.splitlines()]
    return {'ran': len(files), 'failed': failed}


def node_file(name, port, logs, label, seconds=FILE_SECONDS):
    """One compiled test file against a freshly emptied cluster: its failed tests."""
    reset(port)
    environment = {**os.environ, 'PGPORT': port, 'PGDATABASE': 'nocheh', 'SERVICE_TOKEN': SERVICE_TOKEN,
                   'NOCHEH_STORES_FIXTURE': '1', 'NOCHEH_WORKFLOW_FIXTURE': '1', 'TELEGRAM_ENABLED': 'false',
                   'PYTHONPATH': os.pathsep.join(filter(None, [str(ROOT), os.environ.get('PYTHONPATH')]))}
    stem = Path(name).name
    tap, failures = logs / (stem + '.tap'), logs / (stem + '.failed')
    try:
        exit_code = run(['node', '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination', str(tap),
                         '--test-reporter', str(REPORTER), '--test-reporter-destination', str(failures), name],
                        env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=seconds).returncode
    except subprocess.TimeoutExpired:
        exit_code = f'timeout after {seconds} s'
    text = tap.read_text() if tap.exists() else ''
    counts = dict(line[2:].split(' ', 1) for line in text.splitlines() if line.startswith(('# pass ', '# fail ')))
    rows = [json.loads(line) for line in failures.read_text().splitlines()] if failures.exists() else []
    found = [{'test': row['file'] + ' :: ' + row['test'], 'error': row['error']} for row in rows]
    if exit_code and not found:
        found = [{'test': name + ' :: (whole file)', 'error': f'exit {exit_code}; see {label}/{stem}.tap'}]
    say(f"  {'ok  ' if not found else 'FAIL'} {name}" + (f' ({len(found)} failed)' if found else ''))
    return int(counts.get('pass', 0)) + int(counts.get('fail', 0)), found


def node_files(results, files, label, seconds=FILE_SECONDS):
    """Each file on its own, against a freshly emptied cluster; one worker per cluster."""
    logs = results / label
    logs.mkdir()
    queue = list(reversed(files))
    lock = threading.Lock()
    outcomes = []

    def worker(port):
        while True:
            with lock:
                if not queue:
                    return
                name = queue.pop()
            outcome = node_file(name, port, logs, label, seconds)
            with lock:
                outcomes.append(outcome)
    workers = [threading.Thread(target=worker, args=(port,)) for port in ports()]
    for thread in workers:
        thread.start()
    for thread in workers:
        thread.join()
    return {'ran': sum(count for count, _ in outcomes), 'failed': sorted((item for _, found in outcomes for item in found),
                                                                          key=lambda item: item['test'])}


def node(results, only=None):
    files = sorted(str(path.relative_to(ROOT)) for path in (ROOT / 'dist/test').glob('*.test.js'))
    files += sorted(str(path.relative_to(ROOT)) for path in (ROOT / 'test').glob('dashboard-*.test.mjs'))
    return node_files(results, [name for name in files if not only or any(part in name for part in only)], 'node')


def browser(results, only=None):
    return node_files(results, ['test/dashboard-pages.browser.mjs'], 'browser', BROWSER_SECONDS)


# name, Python, PYTHONPATH (besides the repository), how its tests are found
PYTHON_SUITES = (
    ('hermes', HERMES_PYTHON, [HERMES], ['--start', 'services/hermes']),
    ('telegram', HERMES_PYTHON, [HERMES], ['--start', 'services/telegram']),
    ('reader', HERMES_PYTHON, [HERMES], ['--start', 'services/reader']),
    # services/honcho has no __init__.py, and its tests import their module relatively.
    ('honcho', HONCHO_PYTHON, [], ['--modules'] + sorted('services.honcho.' + path.stem
                                                           for path in (ROOT / 'services/honcho').glob('test_*.py'))),
    ('tools', HERMES_PYTHON, [HERMES], ['--start', 'test', '--top', 'test']),
)


def python(results, only=None):
    logs = results / 'python'
    logs.mkdir()
    ran, failed = 0, []
    for name, interpreter, paths, selection in PYTHON_SUITES:
        if only and name not in only:
            continue
        if not interpreter.exists():
            raise SystemExit(f'{interpreter} is missing: run with --setup first.')
        # A short HERMES_HOME: Unix socket paths have a length limit.
        with tempfile.TemporaryDirectory(prefix='nocheh-check-', dir='/tmp') as home:
            environment = {**os.environ, 'HERMES_HOME': home, 'SERVICE_TOKEN': SERVICE_TOKEN,
                           'PYTHONPATH': os.pathsep.join(str(path) for path in paths + [ROOT]), 'PYTHONDONTWRITEBYTECODE': '1'}
            out = logs / (name + '.json')
            with (logs / (name + '.log')).open('w') as log:
                run([str(interpreter), '-m', 'tools.development.unittest_report', '--out', str(out)] + selection,
                    env=environment, stdout=log, stderr=subprocess.STDOUT)
        if not out.exists():
            row = {'ran': 0, 'failed': [{'test': name + ' (whole suite)', 'error': f'did not finish; see python/{name}.log'}]}
        else:
            row = json.loads(out.read_text())
        ran += row['ran']
        found = [{'test': name + ' :: ' + item['test'], 'error': item['error']} for item in row['failed']]
        failed += found
        say(f"  {'ok  ' if not found else 'FAIL'} {name}: {row['ran']} tests" + (f', {len(found)} failed' if found else ''))
    return {'ran': ran, 'failed': failed}


def compare(section, row, known):
    listed = known.get(section, {})
    names = {item['test'] for item in row['failed']}
    return {**row, 'new': [item for item in row['failed'] if item['test'] not in listed],
            'known': [item for item in row['failed'] if item['test'] in listed],
            'fixed': sorted(name for name in listed if name not in names)}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], epilog=__doc__.split('\n\n', 2)[2],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--setup', action='store_true', help='Make or update the Python environments first')
    parser.add_argument('--only', nargs='+', choices=SECTIONS, help='Run only these sections')
    parser.add_argument('--skip', nargs='+', choices=SECTIONS, default=[], help='Leave out these sections')
    parser.add_argument('--no-build', action='store_true', help='Use the compiled Node tests already in dist/')
    parser.add_argument('--files', nargs='+', help='Only Node test files whose path has one of these parts, and Python '
                        'suites with these names (hermes, telegram, reader, honcho, tools)')
    args = parser.parse_args()
    if args.setup:
        setup()
    sections = [name for name in (args.only or SECTIONS) if name not in args.skip]
    known = json.loads(KNOWN.read_text())
    results = ROOT / 'data/test-results' / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    results.mkdir(parents=True)
    if {'node', 'browser'} & set(sections) and not args.no_build:
        run(['npm', 'run', 'build'], check=True, stdout=subprocess.DEVNULL)
    summary = {}
    for section in sections:
        say(f'== {section}')
        started = time.monotonic()
        row = compare(section, globals()[section](results, args.files), known)
        if args.files:
            row['fixed'] = []
        summary[section] = {**row, 'seconds': round(time.monotonic() - started)}
        say(f"   {row['ran']} ran, {len(row['new'])} new failures, {len(row['known'])} known, {len(row['fixed'])} known now pass")
    (results / 'summary.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
    say('')
    for section, row in summary.items():
        for item in row['new']:
            say(f"NEW FAILURE  {section}: {item['test']}\n             {item['error']}")
        for item in row['known']:
            say(f"known        {section}: {item['test']}  ({known[section][item['test']]['reason']})")
        for name in row['fixed']:
            say(f'now passes   {section}: {name}  (take it off test/known-failures.json)')
    new = sum(len(row['new']) for row in summary.values())
    say(f"\n{'PASSED' if not new else 'FAILED'}: {sum(row['ran'] for row in summary.values())} tests in {', '.join(summary)}; "
        f"{new} new failures. Details in {results.relative_to(ROOT)}/.")
    return 1 if new else 0


if __name__ == '__main__':
    raise SystemExit(main())
