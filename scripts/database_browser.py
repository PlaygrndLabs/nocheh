"""Read-only, bounded table browsing for the owner dashboard.

PostgreSQL queries run inside the installation's database containers. SQLite
sessions are opened in read-only mode from registered Hermes profiles only.
No caller-supplied SQL, database path, or identifier reaches a query.
"""
import json
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

from .configuration import compose_command, load

PAGE_SIZE = 50
MAX_OFFSET = 10000
MAX_CELL = 500


def _identifier(value):
    return '"' + value.replace('"', '""') + '"'


def _literal(value):
    return "'" + value.replace("'", "''") + "'"


def _bounded(value, limit, code):
    if not isinstance(value, str) or len(value) > limit or '\0' in value:
        raise ValueError(code)
    return value


def _catalog(state):
    config = load(state)
    layout = config.get('NOCHEH_STORAGE_LAYOUT', 'legacy')
    databases = []
    if layout == 'legacy':
        databases.append({'id': 'archive', 'name': 'Archive · legacy', 'engine': 'postgres',
                          'service': 'nocheh-db', 'database': 'nocheh', 'user': 'nocheh'})
    else:
        for name in ('archive', 'derived', 'control'):
            databases.append({'id': name, 'name': name.title(), 'engine': 'postgres',
                              'service': 'nocheh-db', 'database': 'nocheh_' + name, 'user': 'nocheh'})
    databases.append({'id': 'workflow', 'name': 'Workflow · Inngest', 'engine': 'postgres',
                      'service': 'nocheh-db', 'database': 'nocheh_inngest', 'user': 'nocheh'})
    if config.get('NOCHEH_HONCHO_ENABLED') == 'true':
        databases.append({'id': 'honcho', 'name': 'Honcho memory', 'engine': 'postgres',
                          'service': 'honcho-postgres', 'database': 'honcho_experiment', 'user': 'experiment'})
    from integrations.hermes.native_memory import registered_profiles
    from integrations.hermes.isolated_profile import database_path
    root = Path(state) / 'hermes'
    if root.is_symlink():
        raise ValueError('database_path_denied')
    for profile in registered_profiles(root):
        path = database_path(profile)
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            continue
        databases.append({'id': 'hermes:' + profile.name, 'name': 'Hermes · ' + profile.name,
                          'engine': 'sqlite', 'path': path})
    provider = Path(state) / 'provider/monitor/usage.sqlite'
    if provider.is_file() and not provider.is_symlink():
        databases.append({'id': 'provider-usage', 'name': 'Provider usage',
                          'engine': 'sqlite', 'path': provider})
    honcho_state = Path(config.get('NOCHEH_HONCHO_STATE_DIR') or Path(state) / 'honcho')
    ledger = honcho_state / 'ledger/budget.sqlite'
    if config.get('NOCHEH_HONCHO_ENABLED') == 'true' and ledger.is_file() and not ledger.is_symlink():
        databases.append({'id': 'honcho-ledger', 'name': 'Honcho budget ledger',
                          'engine': 'sqlite', 'path': ledger})
    return databases


def _database(state, database_id):
    _bounded(database_id, 160, 'invalid_database')
    found = next((db for db in _catalog(state) if db['id'] == database_id), None)
    if not found:
        raise ValueError('database_not_found')
    return found


def _pg(state, db, query):
    command = compose_command(state) + ['exec', '-T', '-e',
        'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000',
        db['service'], 'psql', '-X', '-q', '-A', '-t', '-P', 'pager=off',
        '-v', 'ON_ERROR_STOP=1', '-U', db['user'], '-d', db['database'], '-c', query]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=12, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('database_unavailable') from None
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError('database_unavailable')
    try:
        return [json.loads(line) for line in result.stdout.splitlines() if line]
    except (ValueError, TypeError):
        raise ValueError('database_response_invalid') from None


def _pg_tables(state, db):
    return _pg(state, db, """SELECT json_build_object('schema', n.nspname, 'name', c.relname,
      'estimated_rows', greatest(c.reltuples::bigint,0))
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname,c.relname LIMIT 1000""")


def _pg_columns(state, db, schema, table):
    query = """SELECT json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod))
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=%s AND c.relname=%s AND c.relkind IN ('r','p')
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 150""" % (_literal(schema), _literal(table))
    return _pg(state, db, query)


def _sqlite(state, db):
    path = db['path']
    # Each path is discovered from one configured installation location. Never
    # accept a path from the browser, or follow a replaced symlink at open time.
    roots = [Path(state) / 'hermes', Path(state) / 'provider/monitor',
             Path(load(state).get('NOCHEH_HONCHO_STATE_DIR') or Path(state) / 'honcho') / 'ledger']
    if path.is_symlink() or not any(path.resolve().is_relative_to(root.resolve()) for root in roots):
        raise ValueError('database_path_denied')
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        connection.execute('PRAGMA query_only=ON')
        return connection
    except sqlite3.Error:
        raise ValueError('database_unavailable') from None


def _sqlite_tables(db, state):
    with closing(_sqlite(state, db)) as connection:
        return [{'schema': 'main', 'name': name, 'estimated_rows': None} for (name,) in
                connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 1000")]


def _sqlite_columns(connection, table):
    return [{'name': row[1], 'type': row[2] or 'value'} for row in
            connection.execute('PRAGMA table_info(' + _identifier(table) + ')')][:150]


def _rows_pg(state, db, schema, table, columns, sort, direction, filter_column, filter_text, offset):
    names = {column['name'] for column in columns}
    if sort and sort not in names or filter_column and filter_column not in names:
        raise ValueError('invalid_column')
    selected = ','.join('CASE WHEN source.%s IS NULL THEN NULL ELSE left(source.%s::text,%d) END AS %s' %
                        (_identifier(name), _identifier(name), MAX_CELL, _identifier(name))
                        for name in [column['name'] for column in columns])
    where = ''
    if filter_column and filter_text:
        where = ' WHERE position(lower(convert_from(decode(\'%s\',\'hex\'),\'UTF8\')) in lower(%s::text))>0' % (
            filter_text.encode('utf-8').hex(), 'source.' + _identifier(filter_column))
    order = ' ORDER BY source.' + _identifier(sort or columns[0]['name']) + ' ' + direction.upper() + ' NULLS LAST'
    query = 'SELECT row_to_json(row) FROM (SELECT %s FROM %s.%s source%s%s LIMIT %d OFFSET %d) row' % (
        selected, _identifier(schema), _identifier(table), where, order, PAGE_SIZE + 1, offset)
    return _pg(state, db, query)


def _rows_sqlite(state, db, table, columns, sort, direction, filter_column, filter_text, offset):
    names = {column['name'] for column in columns}
    if sort and sort not in names or filter_column and filter_column not in names:
        raise ValueError('invalid_column')
    selected = ','.join("CASE WHEN typeof(source.%s)='blob' THEN hex(substr(source.%s,1,250)) "
                        "ELSE substr(CAST(source.%s AS TEXT),1,%d) END AS %s" %
                        (_identifier(name), _identifier(name), _identifier(name), MAX_CELL, _identifier(name))
                        for name in [column['name'] for column in columns])
    where = ' WHERE instr(lower(CAST(source.%s AS TEXT)),lower(?))>0' % _identifier(filter_column) if filter_column and filter_text else ''
    order = ' ORDER BY source.' + _identifier(sort or columns[0]['name']) + ' ' + direction.upper()
    query = 'SELECT %s FROM %s source%s%s LIMIT ? OFFSET ?' % (selected, _identifier(table), where, order)
    parameters = ([filter_text] if where else []) + [PAGE_SIZE + 1, offset]
    with closing(_sqlite(state, db)) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(query, parameters)]


def view(state, request):
    action = request.get('action', 'databases')
    if action == 'databases':
        return {'databases': [{key: value for key, value in db.items() if key not in ('service', 'database', 'user', 'path')}
                              for db in _catalog(state)]}
    if action not in ('tables', 'rows'):
        raise ValueError('invalid_browser_action')
    db = _database(state, request.get('database', ''))
    tables = _pg_tables(state, db) if db['engine'] == 'postgres' else _sqlite_tables(db, state)
    if action == 'tables':
        return {'tables': tables}
    schema = _bounded(request.get('schema', ''), 128, 'invalid_table')
    table = _bounded(request.get('table', ''), 128, 'invalid_table')
    if not any(item['schema'] == schema and item['name'] == table for item in tables):
        raise ValueError('table_not_found')
    sort = _bounded(request.get('sort', ''), 128, 'invalid_column')
    direction = request.get('direction', 'asc')
    if direction not in ('asc', 'desc'):
        raise ValueError('invalid_sort')
    filter_column = _bounded(request.get('filter_column', ''), 128, 'invalid_column')
    filter_text = _bounded(request.get('filter', ''), 200, 'invalid_filter')
    try:
        offset = int(request.get('offset', '0'))
    except (TypeError, ValueError):
        raise ValueError('invalid_offset') from None
    if offset < 0 or offset > MAX_OFFSET:
        raise ValueError('invalid_offset')
    if db['engine'] == 'postgres':
        columns = _pg_columns(state, db, schema, table)
        if not columns:
            raise ValueError('table_not_found')
        rows = _rows_pg(state, db, schema, table, columns, sort, direction, filter_column, filter_text, offset)
    else:
        with closing(_sqlite(state, db)) as connection:
            columns = _sqlite_columns(connection, table)
        if not columns:
            raise ValueError('table_not_found')
        rows = _rows_sqlite(state, db, table, columns, sort, direction, filter_column, filter_text, offset)
    return {'database': db['id'], 'schema': schema, 'table': table, 'columns': columns,
            'rows': rows[:PAGE_SIZE], 'next_offset': offset + PAGE_SIZE if len(rows) > PAGE_SIZE and offset + PAGE_SIZE <= MAX_OFFSET else None,
            'offset': offset, 'cell_limit': MAX_CELL}
