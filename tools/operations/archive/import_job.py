"""Bounded Telegram upload inspection and resumable imports using archive.py."""
import hashlib
import json
import os
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from tools.operations.archive.archive import API, desktop_records, media_path, upload, send_bytes, digest, canonical

MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_FILES = 10000
MAX_EXPORT = 128 * 1024 * 1024
# The original export is kept as parts under the per-file limit.
EXPORT_PART = 32 * 1024 * 1024


def safe_name(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or '\0' in name or path.is_absolute() or any(x in ('..', '.') for x in name.split('/')):
        raise ValueError('unsafe_upload_path')
    return path


def unpack(directory):
    root = directory / 'upload'
    zips = list(root.glob('*.zip'))
    if len(zips) > 1: raise ValueError('upload_one_zip')
    if not zips: return root
    target = directory / 'unpacked'
    # Re-extraction is deterministic and never mixes a prior partial extraction.
    import shutil
    if target.exists(): shutil.rmtree(target)
    target.mkdir(mode=0o700)
    with zipfile.ZipFile(zips[0]) as source:
        members = source.infolist(); seen = set(); size = 0
        if len(members) > MAX_FILES: raise ValueError('too_many_files')
        for member in members:
            path = safe_name(member.filename.rstrip('/'))
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError('unsafe_zip_member')
            if str(path) in seen: raise ValueError('duplicate_zip_member')
            seen.add(str(path)); size += member.file_size
            limit = MAX_EXPORT if path.suffix == '.json' else MAX_FILE
            if member.file_size > limit or size > MAX_TOTAL: raise ValueError('upload_size_limit')
            destination = target / path
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.is_dir(): destination.mkdir(exist_ok=True, mode=0o700); continue
            with source.open(member) as incoming, destination.open('xb') as output:
                total = 0
                while chunk := incoming.read(1024 * 1024):
                    total += len(chunk)
                    if total > member.file_size or total > limit: raise ValueError('upload_size_limit')
                    output.write(chunk)
            destination.chmod(0o600)
    return target


def inspect(directory, mapping=None):
    root = unpack(directory)
    candidates = list(root.rglob('result.json'))
    if not candidates:
        candidates = list(root.rglob('*.json'))
    if len(candidates) != 1: raise ValueError('select_one_telegram_export')
    file = candidates[0]
    if file.stat().st_size > MAX_EXPORT: raise ValueError('export_json_exceeds_128_mib')
    document = json.loads(file.read_text())
    if not isinstance(document, dict): raise ValueError('expected_telegram_desktop_json')
    chats = document.get('chats', {}).get('list') if isinstance(document.get('chats'), dict) else None
    chats = [document] if chats is None else chats
    if not isinstance(chats, list) or not chats: raise ValueError('empty_export')
    summaries = []
    # Validate every record/path before committing anything to the archive.
    count = missing = supplied = 0
    for record, uploads in desktop_records(document, file.parent, scope_map=mapping):
        count += 1; supplied += len(uploads)
        missing += sum(a['state'] == 'failed' for a in record['artifacts'])
        if any(path.stat().st_size > MAX_FILE for _, path in uploads): raise ValueError('attachment_exceeds_50_mib')
    for chat in chats:
        first, last = date_range(chat['messages'])
        summaries.append({'id': str(chat['id']), 'name': str(chat.get('name', 'Untitled chat')),
                          'messages': len(chat['messages']), 'type': str(chat.get('type', 'unknown')),
                          'topics': sum(isinstance(m, dict) and m.get('action') == 'topic_created' for m in chat['messages']),
                          'scope': (mapping or {}).get(str(chat['id']), f"desktop:{chat.get('type', 'unknown')}:{chat['id']}"),
                          'first_at': first, 'last_at': last})
    starts = [chat['first_at'] for chat in summaries if chat['first_at']]
    ends = [chat['last_at'] for chat in summaries if chat['last_at']]
    return {'file': str(file.relative_to(directory)), 'sha256': digest(file.read_bytes()),
            'chats': summaries, 'messages': count, 'missing_files': missing, 'supplied_files': supplied,
            'first_at': min(starts, default=None), 'last_at': max(ends, default=None)}


def date_range(messages):
    """Earliest and latest message time as UTC ISO strings; undated messages are skipped."""
    times = []
    for message in messages:
        value = message.get('date_unixtime') if isinstance(message, dict) else None
        try: seconds = int(value)
        except (TypeError, ValueError): continue
        if 0 < seconds < 2**37: times.append(seconds)
    if not times: return None, None
    stamp = lambda seconds: datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z')
    return stamp(min(times)), stamp(max(times))


def file_digest(file):
    value = hashlib.sha256()
    with file.open('rb') as source:
        while chunk := source.read(1024 * 1024): value.update(chunk)
    return value.hexdigest()


def export_parts(file, batch_key, sha256):
    """The original export as one file, or as numbered parts when it is over the per-file limit."""
    size = file.stat().st_size; base = digest(batch_key); count = max(1, -(-size // EXPORT_PART))
    if count == 1:
        return [{'id': digest(base + ':original-export'), 'source_ref': 'original-export', 'metadata': {'sha256': sha256}, 'offset': 0, 'size': size}]
    return [{'id': digest(f'{base}:original-export:{n + 1}'), 'source_ref': f'original-export:{n + 1}',
             'metadata': {'sha256': sha256, 'part': n + 1, 'parts': count, 'offset': n * EXPORT_PART},
             'offset': n * EXPORT_PART, 'size': min(EXPORT_PART, size - n * EXPORT_PART)} for n in range(count)]


def prepared_records(directory, file, sha256, mapping):
    """Parse the export once into one line per message, so each batch reads only its lines."""
    target = directory / 'records.jsonl'; status = file.stat()
    header = {'sha256': sha256, 'mapping': digest(canonical(mapping)), 'size': status.st_size, 'mtime_ns': status.st_mtime_ns}
    try:
        with target.open() as lines:
            if json.loads(lines.readline()) == header: return target
    except (OSError, ValueError): pass
    if file_digest(file) != sha256: raise ValueError('export_integrity_failed')
    document = json.loads(file.read_text()); partial = directory / 'records.jsonl.partial'
    with partial.open('w') as output:
        partial.chmod(0o600)
        output.write(json.dumps(header) + '\n')
        for record, uploads in desktop_records(document, file.parent, scope_map=mapping):
            output.write(json.dumps({'record': record, 'uploads': [[artifact_id, str(path.relative_to(file.parent.resolve()))] for artifact_id, path in uploads]}, ensure_ascii=False) + '\n')
    os.replace(partial, target)
    return target


def records(path, root, after=0):
    with path.open() as lines:
        lines.readline()
        for index, line in enumerate(lines):
            if index < after: continue
            item = json.loads(line)
            yield index, item['record'], [(artifact_id, media_path(root, name)) for artifact_id, name in item['uploads']]


def run(directory, mapping, after=0, api=None, *, limit=None, duplicates=None, learning_after=0):
    if limit is not None and (type(limit) is not int or not 1 <= limit <= 100): raise ValueError('invalid_import_batch_limit')
    if type(after) is not int or after < 0 or type(learning_after) is not int or learning_after < 0: raise ValueError('invalid_import_checkpoint')
    # The immutable preview identifies the already-validated uploaded file.
    metadata = json.loads((directory / 'job.json').read_text())
    preview = metadata['preview']; file = directory / safe_name(preview['file'])
    duplicates = metadata.get('duplicates', 0) if duplicates is None else duplicates
    if type(duplicates) is not int or duplicates < 0: raise ValueError('invalid_import_checkpoint')
    if after > preview['messages'] or learning_after > preview['messages']: raise ValueError('invalid_import_checkpoint')
    lines = prepared_records(directory, file, preview['sha256'], mapping); api = api or API()
    batch_key = 'telegram-import:' + digest(canonical({'sha256': preview['sha256'], 'mapping': mapping}))
    event = {'version': 1, 'key': batch_key, 'bot_id': 'desktop-export', 'origin': 'import',
             'scope': 'import:' + preview['sha256'], 'kind': 'import_manifest', 'source_id': preview['sha256'],
             'revision': digest(batch_key), 'occurred_at': None, 'text': None,
             'payload': {'export_sha256': preview['sha256'], 'scope_map': mapping, 'messages': preview['messages']}}
    parts = export_parts(file, batch_key, preview['sha256'])
    api.call('/v1/import', {'event': event, 'artifacts': [{'id': part['id'], 'source_ref': part['source_ref'],
             'kind': 'telegram_export', 'state': 'pending', 'metadata': part['metadata']} for part in parts], 'derived': []})
    # The first batch sends the original export; a later batch runs only after an earlier one finished.
    if after == 0:
        if file_digest(file) != preview['sha256']: raise ValueError('export_integrity_failed')
        with file.open('rb') as original:
            for part in parts:
                original.seek(part['offset']); send_bytes(api, part['id'], original.read(part['size']))
    completed = after
    for index, record, uploads in records(lines, file.parent, after):
        if limit is not None and index >= after + limit: break
        result = api.call('/v1/import', record)
        for artifact_id, path in uploads: upload(api, artifact_id, path)
        # A message the bot already saved live counts as a duplicate too.
        duplicates += int(bool(result.get('duplicate') or result.get('live_copy')))
        completed = index + 1
        print(json.dumps({'completed': index + 1, 'duplicates': duplicates}), flush=True)
    # Only queue after all records and available file bytes were ingested. The
    # persisted import-step decision survives cancellation and retries.
    approved = metadata.get('review_approved') is True
    if approved and completed == preview['messages']:
        ids = [digest(record['event']['key']) for _, record, _ in records(lines, file.parent)]
        end = len(ids) if limit is None else min(len(ids), learning_after + limit)
        for start in range(learning_after, end, 500):
            api.call('/v1/memory/reviews', {'approved': True, 'batch': directory.name, 'event_ids': ids[start:min(end,start+500)]})
        learning_after = end
    result = {'completed': completed, 'duplicates': duplicates, 'telegram_replies': 0, 'review_approved': approved}
    if limit is not None:
        result.update(learning_after=learning_after, complete=completed == preview['messages'] and (not approved or learning_after == preview['messages']))
    return result
