"""The owner's tasks, sharing rules and settings through the owner API; nothing imported acts by itself."""
import json
import re
import urllib.error
from pathlib import Path
from urllib.parse import urlencode
from tools.operations.archive.archive import file_digest

FORMAT = 'nocheh-owner-data-v1'
RECORD = 'nocheh-owner-record-v1'


def _tables(value):
    tables = value.get('tables') if isinstance(value, dict) else None
    if value.get('format') != FORMAT or not isinstance(tables, list): raise ValueError('owner_format_unsupported')
    if len(tables) != len(set(tables)) or any(not isinstance(t, str) or not re.fullmatch('[a-z_]{1,80}', t) for t in tables):
        raise ValueError('owner_tables_invalid')
    return tables


def _valid(record, tables):
    return (isinstance(record, dict) and record.get('format') == RECORD and record.get('table') in tables
            and isinstance(record.get('row'), dict) and isinstance(record.get('key'), list)
            and re.fullmatch('[a-f0-9]{64}', str(record.get('sha256', ''))) is not None)


def export_owner(api, directory):
    directory = Path(directory); directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    tables = _tables(api.call('/v1/exports/owner-data/tables'))
    manifest = {'format': FORMAT, 'complete': False, 'records': 0, 'tables': tables, 'automatic_activation': False}
    metadata = directory / 'manifest.json'; metadata.write_text(json.dumps(manifest, indent=2) + '\n'); metadata.chmod(0o600)
    records = directory / 'records.ndjson'
    with records.open('w') as output:
        records.chmod(0o600)
        for table in tables:
            after = ''
            while True:
                page = api.call('/v1/exports/owner-data?' + urlencode({'table': table, 'after': after, 'limit': 50}))
                if page.get('format') != FORMAT or page.get('table') != table or not isinstance(page.get('records'), list):
                    raise ValueError('owner_format_unsupported')
                for record in page['records']:
                    if not _valid(record, tables) or record['table'] != table: raise ValueError('owner_record_invalid')
                    output.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n'); manifest['records'] += 1
                cursor = page.get('next')
                if cursor is None: break
                if not isinstance(cursor, str) or not cursor or len(cursor) > 4096 or cursor == after: raise ValueError('owner_cursor_invalid')
                after = cursor
    manifest.update(complete=True, records_sha256=file_digest(records))
    metadata.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def validate_owner(directory):
    directory = Path(directory); metadata = directory / 'manifest.json'; records = directory / 'records.ndjson'
    if metadata.is_symlink() or records.is_symlink(): raise ValueError('owner_path_denied')
    manifest = json.loads(metadata.read_text())
    if manifest.get('format') != FORMAT or manifest.get('complete') is not True: raise ValueError('incomplete_owner_export')
    if file_digest(records) != manifest.get('records_sha256'): raise ValueError('owner_records_integrity_failed')
    tables = _tables(manifest); count = 0
    with records.open('rb') as source:
        while line := source.readline(8 * 1024 * 1024 + 1):
            if len(line) > 8 * 1024 * 1024: raise ValueError('owner_record_too_large')
            if not _valid(json.loads(line), tables): raise ValueError('owner_record_invalid')
            count += 1
    if count != manifest.get('records'): raise ValueError('owner_record_count_mismatch')
    return manifest


def import_owner(api, directory):
    """Table by table, in the order the destination gives. A task whose parent task
    has not arrived yet waits for the next pass; a pass with no progress stops."""
    directory = Path(directory); manifest = validate_owner(directory)
    available = _tables(api.call('/v1/exports/owner-data/tables'))
    if any(table not in available for table in manifest['tables']): raise ValueError('owner_format_unsupported')
    totals = {'added': 0, 'unchanged': 0, 'kept': 0}
    with (directory / 'records.ndjson').open('rb') as source:
        for table in available:
            waiting = []
            source.seek(0)
            for line in source:
                record = json.loads(line)
                if record['table'] == table: waiting.append(record)
            while waiting:
                pending = []
                for record in waiting:
                    try: result = api.call('/v1/imports/owner-data', {'records': [record]})
                    except urllib.error.HTTPError as error:
                        try: code = json.loads(error.read(65536)).get('error')
                        except (ValueError, AttributeError): code = None
                        if table == 'owner_tasks' and error.code == 409 and code == 'portable_parent_pending':
                            pending.append(record); continue
                        raise RuntimeError('owner_import_failed:' + str(code or error.code)) from None
                    for key in totals: totals[key] += int(result.get(key, 0))
                if len(pending) == len(waiting): raise ValueError('owner_parents_missing_or_cyclic')
                waiting = pending
    return {**totals, 'automatic_activation': False}
