"""Hermes's and Honcho's own tests at the revisions Nocheh pins, for tools/development/check_all.py --only upstream.

Run before an upgrade of either goes live: the upstream test suites, on Nocheh's Python and Postgres versions.
Nothing here needs a key or calls a model; both suites fake every provider and refuse the network.

  honcho  Honcho's whole pytest suite, as its own CI runs it, against a synthetic Postgres 18 with pgvector
          (NOCHEH_CHECK_VECTOR_PGPORT on PGHOST, started with cluster_name=nocheh-stores-fixture). Upstream tests on
          Postgres 15, so this also catches what changes on the version Nocheh runs.
  hermes  The Hermes test files for the Hermes modules Nocheh's plugins import (named after them), plus the storage,
          contract, cron and memory-plugin folders, through Hermes's own per-file runner.

The checkouts and environments live under data/test-env/ and are made by check_all --setup. The sources are
downloaded at run time and never committed: Honcho is AGPL.
"""
from tools.paths import ROOT
import json
import os
import re
import subprocess
import xml.etree.ElementTree as ElementTree

ENVIRONMENTS = ROOT / 'data/test-env'
HERMES = ENVIRONMENTS / 'hermes-agent'
HERMES_TEST_PYTHON = ENVIRONMENTS / 'hermes-upstream/bin/python'
HONCHO = ENVIRONMENTS / 'honcho-upstream'
HONCHO_TEST_PYTHON = ENVIRONMENTS / 'honcho-dev/bin/python'
HONCHO_DATABASE = 'honcho_upstream'
# Whole Hermes test folders Nocheh depends on beyond single modules: the session store and its contracts (the
# history Nocheh reads and edits), schedules, and the memory provider plugins.
HERMES_FOLDERS = ('persistence_sqlite', 'contracts', 'cron', 'plugins/memory')
HERMES_FILES = ('test_hermes_state_standin.py', 'test_hermes_state_standin_collected.py')
# Modules almost every Hermes test imports; matching on them would select most of the suite.
HERMES_HUBS = {'run_agent', 'hermes_constants', 'hermes_cli.config'}
# Last names too common to name a test file after one module.
HERMES_COMMON = {'config', 'base', 'jobs', 'auth', 'messages', 'sessions'}
FILE_SECONDS = 600
# The settings Honcho's own CI sets (.github/workflows/unittest.yml): a fake OpenAI-compatible provider for every model.
HONCHO_SETTINGS = {
    'AUTH_USE_AUTH': 'false', 'SENTRY_ENABLED': 'false', 'LLM_OPENAI_COMPATIBLE_API_KEY': 'test-key',
    'LLM_OPENAI_COMPATIBLE_BASE_URL': 'http://localhost:8000', 'DERIVER_PROVIDER': 'openai', 'DERIVER_MODEL': 'test',
    'DIALECTIC_QUERY_GENERATION_PROVIDER': 'openai', 'DIALECTIC_QUERY_GENERATION_MODEL': 'test',
    'SUMMARY_PROVIDER': 'openai', 'SUMMARY_MODEL': 'test',
    **{f'DIALECTIC_LEVELS__{level}__{key}': value
       for level, iterations in (('minimal', 2), ('low', 5), ('medium', 4), ('high', 4), ('max', 10))
       for key, value in (('PROVIDER', 'openai'), ('MODEL', 'test'), ('THINKING_BUDGET_TOKENS', '0'),
                          ('MAX_TOOL_ITERATIONS', str(iterations)))},
}
IMPORT = re.compile(r'^\s*(?:from\s+([\w.]+)\s+import\s+\(?\s*([\w, \n]+?)\)?\s*$|import\s+([\w.]+))', re.M)


def run(command, **options):
    return subprocess.run(command, cwd=ROOT, **options)


def setup():
    """Honcho's checkout with its dev environment, and a Hermes environment with Hermes's test tools."""
    from tools.development.check_all import checkout
    honcho = json.loads((ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']
    checkout(HONCHO, honcho['repository'], honcho['revision'])
    run(['uv', 'sync', '--quiet', '--project', str(HONCHO), '--frozen', '--all-extras', '--dev'],
        env={**os.environ, 'UV_PROJECT_ENVIRONMENT': str(HONCHO_TEST_PYTHON.parents[1])}, check=True)
    # The Hermes checkout itself is made by check_all's setup; the same extras as deploy/hermes.Dockerfile.
    run(['uv', 'sync', '--quiet', '--project', str(HERMES), '--frozen', '--group', 'dev', '--group', 'test', '--extra',
         'messaging', '--extra', 'anthropic', '--extra', 'mcp', '--python', '3.14'],
        env={**os.environ, 'UV_PROJECT_ENVIRONMENT': str(HERMES_TEST_PYTHON.parents[1])}, check=True)


def imported(text):
    """Every module name a Python file imports, with `from a import b` also giving a.b."""
    names = set()
    for source, members, plain in IMPORT.findall(text):
        if plain:
            names.add(plain)
            continue
        names.add(source)
        names.update(source + '.' + member for member in re.split(r'[,\s]+', members) if member and member != 'as')
    return names


def hermes_modules():
    """The Hermes modules (single files) Nocheh's Hermes plugins import, leaving out Nocheh's own tools/ modules."""
    def hermes_file(name):
        return HERMES.joinpath(*name.split('.')).with_suffix('.py').exists()

    def ours(name):
        path = ROOT.joinpath(*name.split('.'))
        return path.with_suffix('.py').exists() or path.is_dir()
    found = set()
    for path in (ROOT / 'services/hermes').glob('*.py'):
        if not path.name.startswith('test_'):
            found.update(name for name in imported(path.read_text()) if hermes_file(name) and not ours(name))
    return found


def hermes_files():
    """Hermes test files named after a module Nocheh imports, plus the folders Nocheh depends on as a whole."""
    names = {module.split('.')[-1].lstrip('_') for module in hermes_modules() - HERMES_HUBS} - HERMES_COMMON
    files = {path for path in (HERMES / 'tests').glob('**/test_*.py')
             if any(path.stem[5:] == name or path.stem[5:].startswith(name + '_') for name in names)}
    for folder in HERMES_FOLDERS:
        files.update((HERMES / 'tests' / folder).glob('**/test_*.py'))
    files.update(HERMES / 'tests' / name for name in HERMES_FILES if (HERMES / 'tests' / name).exists())
    return sorted(str(path.relative_to(HERMES)) for path in files)


def honcho(logs):
    """Honcho's pytest suite on a fresh database of the pgvector cluster."""
    port = os.environ.get('NOCHEH_CHECK_VECTOR_PGPORT')
    if not port:
        raise SystemExit('Set NOCHEH_CHECK_VECTOR_PGPORT to a synthetic Postgres 18 with pgvector (see --help).')
    from tools.development.check_all import psql
    if psql(port, 'postgres', "SELECT current_setting('cluster_name')") != 'nocheh-stores-fixture':
        raise SystemExit('The pgvector Postgres must be a synthetic one started with cluster_name=nocheh-stores-fixture.')
    psql(port, 'postgres', f'DROP DATABASE IF EXISTS {HONCHO_DATABASE} WITH (FORCE)')
    psql(port, 'postgres', f'CREATE DATABASE {HONCHO_DATABASE}')
    user, password = os.environ.get('PGUSER', 'postgres'), os.environ.get('PGPASSWORD', '')
    credentials = user + (':' + password if password else '')
    report = logs / 'honcho.xml'
    environment = {**os.environ, **HONCHO_SETTINGS, 'PYTHONDONTWRITEBYTECODE': '1',
                   'DB_CONNECTION_URI': f"postgresql+psycopg://{credentials}@{os.environ['PGHOST']}:{port}/{HONCHO_DATABASE}"}
    with (logs / 'honcho.log').open('w') as log:
        subprocess.run([str(HONCHO_TEST_PYTHON), '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml', str(report)],
                       cwd=HONCHO, env=environment, stdout=log, stderr=subprocess.STDOUT)
    return honcho_report(report)


def honcho_report(report):
    """Tests run, skipped and failed, from pytest's JUnit report."""
    if not report.exists():
        return 0, 0, [{'test': 'honcho :: (whole suite)', 'error': 'did not finish; see upstream/honcho.log'}]
    ran, skipped, failed = 0, 0, []
    for case in ElementTree.parse(report).getroot().iter('testcase'):
        ran += 1
        problem = case.find('failure') if case.find('failure') is not None else case.find('error')
        if case.find('skipped') is not None:
            skipped += 1
        elif problem is not None:
            name = case.get('classname', '').replace('.', '/') + '.py::' + case.get('name', '')
            failed.append({'test': 'honcho :: ' + name, 'error': (problem.get('message') or '').split('\n')[0][:300]})
    return ran - skipped, skipped, failed


SUMMARY = re.compile(r'=== Summary: \d+ files, (\d+) tests passed, \d+ failed(.*) in [\d.]+s')
FAILED = re.compile(r'^[\s║]*(?:FAILED|ERROR) (tests/\S+\.py::\S+)(?: - (.*))?$', re.M)
# After the summary the runner lists every failing file under its cause: "=== 2 files <cause> ===", then "  <file>  ...".
CAUSE = re.compile(r'^=== \d+ files? (.+?) ===\n((?:  \S.*\n?)*)', re.M)


def hermes(logs):
    """The chosen Hermes test files through Hermes's own runner: one fresh pytest per file, network refused."""
    files = hermes_files()
    listing = logs / 'hermes-files.txt'
    listing.write_text('\n'.join(files) + '\n')
    log = logs / 'hermes.log'
    with log.open('w') as output:
        subprocess.run(['scripts/run_tests.sh', '--files-from', str(listing), '--file-timeout', str(FILE_SECONDS),
                        '-j', str(os.cpu_count() or 2)], cwd=HERMES,
                       env={**os.environ, 'HERMES_PYTHON': str(HERMES_TEST_PYTHON)}, stdout=output, stderr=subprocess.STDOUT)
    return hermes_report(log.read_text(errors='replace'))


def hermes_report(text):
    """Tests run, skipped and failed, from the output of Hermes's runner."""
    summary = SUMMARY.search(text)
    if not summary or summary.group(1) == '0':
        return 0, 0, [{'test': 'hermes :: (whole suite)', 'error': 'did not finish or ran nothing; see upstream/hermes.log'}]
    failed = {}
    for name, error in FAILED.findall(text):
        failed.setdefault(name, (error or '').strip()[:300])
    named = {name.split('::')[0] for name in failed}
    # A file that failed without naming a test (an import error, a crash, a time-out, a non-zero exit) fails whole.
    for cause, lines in CAUSE.findall(text[summary.end():]):
        for path in re.findall(r'^  (\S+\.py)', lines, re.M):
            if path not in named:
                failed[path + '::(whole file)'] = cause[:300]
    skipped = re.search(r', (\d+) skipped', summary.group(2))
    return (int(summary.group(1)) + len(failed), int(skipped.group(1)) if skipped else 0,
            [{'test': 'hermes :: ' + name, 'error': error} for name, error in sorted(failed.items())])


SUITES = {'honcho': honcho, 'hermes': hermes}


def upstream(results, only=None):
    """check_all's upstream section."""
    logs = results / 'upstream'
    logs.mkdir()
    from tools.development.check_all import say
    ran, skipped, failed = 0, 0, []
    for name, suite in SUITES.items():
        if only and name not in only:
            continue
        python = HONCHO_TEST_PYTHON if name == 'honcho' else HERMES_TEST_PYTHON
        if not python.exists():
            raise SystemExit(f'{python} is missing: run with --setup first.')
        count, skips, found = suite(logs)
        ran, skipped, failed = ran + count, skipped + skips, failed + found
        say(f"  {'ok  ' if not found else 'FAIL'} {name}: {count} tests" + (f', {len(found)} failed' if found else ''))
    return {'ran': ran, 'skipped': skipped, 'failed': failed}
