"""Upgrade a filled tester copy to the checkout's images and check nothing was lost, for full_test.py --upgrade.

The copy starts on the installation's own images and the scenarios fill it. Then the checkout's images replace them in
place, as an upgrade does: same volumes and state folders, every container made again. Before and after, it counts
every table's rows in each store, every table's rows in each Hermes state.db, and the kept files. A table gone or
with fewer rows, or fewer files, fails the check. Then each chat must still have its history (telegram_scenarios
history_kept) and answer.
"""
import json
import sqlite3
import subprocess
import time
from pathlib import Path

# Every base table's exact row count, in one query.
COUNTS = ("SELECT table_schema||'.'||table_name||'='||(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', "
          "table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_type='BASE TABLE' "
          "AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1")
# (service, user, database) of each store, as full_test.end_of_run_health reads them. Inngest's own database holds
# passing run state, not kept data, so it is left out.
STORES = [('nocheh-db', 'nocheh', database) for database in ('nocheh_archive', 'nocheh_derived', 'nocheh_control')] \
    + [('honcho-postgres', 'experiment', 'honcho_experiment')]
# Tables, by database, whose rows are passing work rather than kept data and may shrink across a restart.
PASSING = {}


def store_counts(command):
    found = {}
    for service, user, database in STORES:
        result = subprocess.run(command+['exec', '-T', service, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', user,
                                         '-d', database, '-c', COUNTS], capture_output=True, text=True, timeout=300)
        if result.returncode:
            found[database+' (unreadable)'] = -1
            continue
        for line in filter(None, result.stdout.splitlines()):
            table, _, count = line.rpartition('=')
            if table not in PASSING.get(database, ()):
                found[database+' '+table] = int(count)
    return found


def hermes_counts(directory):
    """Rows of every table in each Hermes state.db of the copy, read-only from its state folder."""
    found = {}
    root = directory/'state/hermes'
    for path in sorted(root.rglob('state.db')):
        with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as database:
            tables = [row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            for table in tables:
                found[f'hermes {path.parent.relative_to(root)} {table}'] = database.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
    return found


def file_count(directory):
    return {'kept files': sum(1 for path in (directory/'state/files').rglob('*') if path.is_file())}


def snapshot(command, directory):
    return {**store_counts(command), **hermes_counts(directory), **file_count(directory)}


def lost(before, after):
    """Each count that is gone or smaller after the upgrade: {name: [before, after]}."""
    return {name: [count, after.get(name)] for name, count in before.items() if after.get(name) is None or after[name] < count}


def swap_images(directory, tags):
    """Point the copy's Compose file and fixture record at the new images, by image ID, wherever the old ones were.
    The mini app's image is in the Compose file only (telegram_rehearsal adds it)."""
    info = json.loads((directory/'fixture.json').read_text())
    text = (directory/'compose.json').read_text()
    services = json.loads(text)['services']
    old = {**info['images'], **({'miniapp': services['nocheh-miniapp']['image']} if 'nocheh-miniapp' in services else {})}
    for role, tag in tags.items():
        if old.get(role):
            new = json.loads(subprocess.check_output(['docker', 'image', 'inspect', tag], text=True))[0]['Id']
            text = text.replace(old[role], new)
            if role in info['images']:
                info['images'][role] = new
    (directory/'compose.json').write_text(text)
    (directory/'fixture.json').write_text(json.dumps(info, indent=2))


def upgrade(directory, tags, log, step):
    """Upgrade the copy in place to the images in `tags` ({role: tag}) and compare. Returns (steps, scenario row)."""
    info = json.loads((directory/'fixture.json').read_text())
    command = ['docker', 'compose', '-p', info['project'], '-f', str(directory/'compose.json')]
    started = time.monotonic()
    before = snapshot(command, directory)
    swap_images(directory, tags)
    steps = [step('upgrade_copy', command+['up', '-d', '--no-build', '--wait', '--wait-timeout', '600'], log)]
    after = snapshot(command, directory) if steps[0]['passed'] else {}
    missing = lost(before, after) if after else {}
    row = {'scenario': 'upgrade_keeps_data', 'passed': steps[0]['passed'] and not missing,
           'observed': {'counted': len(before), 'lost': missing,
                        'grew': {name: [count, after[name]] for name, count in before.items() if after.get(name, count) > count}},
           'seconds': round(time.monotonic()-started, 1)}
    if not steps[0]['passed']:
        row['error'] = 'the copy did not start on the new images'
    elif missing:
        row['error'] = 'data lost in the upgrade: '+', '.join(f'{name} {counts[0]} -> {counts[1]}' for name, counts in list(missing.items())[:8])
    return steps, row
