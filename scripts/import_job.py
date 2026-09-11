"""Bounded Telegram upload inspection and resumable imports using archive.py."""
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath
from .archive import API, desktop_records, upload, digest, canonical

MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_FILES = 10000


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
            if member.file_size > MAX_FILE or size > MAX_TOTAL: raise ValueError('upload_size_limit')
            destination = target / path
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.is_dir(): destination.mkdir(exist_ok=True, mode=0o700); continue
            with source.open(member) as incoming, destination.open('xb') as output:
                total = 0
                while chunk := incoming.read(1024 * 1024):
                    total += len(chunk)
                    if total > member.file_size or total > MAX_FILE: raise ValueError('upload_size_limit')
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
    if file.stat().st_size > 32 * 1024 * 1024: raise ValueError('export_json_exceeds_32_mib')
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
        summaries.append({'id': str(chat['id']), 'name': str(chat.get('name', 'Untitled chat')),
                          'messages': len(chat['messages']), 'type': str(chat.get('type', 'unknown')),
                          'scope': (mapping or {}).get(str(chat['id']), f"desktop:{chat.get('type', 'unknown')}:{chat['id']}")})
    return {'file': str(file.relative_to(directory)), 'sha256': digest(file.read_bytes()),
            'chats': summaries, 'messages': count, 'missing_files': missing, 'supplied_files': supplied}


def run(directory, mapping, after=0, api=None, *, limit=None, duplicates=None, learning_after=0):
    if limit is not None and (type(limit) is not int or not 1 <= limit <= 100): raise ValueError('invalid_import_batch_limit')
    if type(after) is not int or after < 0 or type(learning_after) is not int or learning_after < 0: raise ValueError('invalid_import_checkpoint')
    # The immutable preview identifies the already-validated uploaded file.
    metadata = json.loads((directory / 'job.json').read_text())
    preview = metadata['preview']; file = directory / safe_name(preview['file'])
    if digest(file.read_bytes()) != preview['sha256']: raise ValueError('export_integrity_failed')
    document = json.loads(file.read_text()); api = api or API()
    duplicates = metadata.get('duplicates', 0) if duplicates is None else duplicates
    if type(duplicates) is not int or duplicates < 0: raise ValueError('invalid_import_checkpoint')
    if after > preview['messages'] or learning_after > preview['messages']: raise ValueError('invalid_import_checkpoint')
    batch_key = 'telegram-import:' + digest(canonical({'sha256': preview['sha256'], 'mapping': mapping}))
    event = {'version': 1, 'key': batch_key, 'bot_id': 'desktop-export', 'origin': 'import',
             'scope': 'import:' + preview['sha256'], 'kind': 'import_manifest', 'source_id': preview['sha256'],
             'revision': digest(batch_key), 'occurred_at': None, 'text': None,
             'payload': {'export_sha256': preview['sha256'], 'scope_map': mapping, 'messages': preview['messages']}}
    artifact_id = digest(digest(batch_key) + ':original-export')
    api.call('/v1/import', {'event': event, 'artifacts': [{'id': artifact_id, 'source_ref': 'original-export',
             'kind': 'telegram_export', 'state': 'pending', 'metadata': {'sha256': preview['sha256']}}], 'derived': []})
    upload(api, artifact_id, file, preview['sha256'])
    completed = after
    for index, (record, uploads) in enumerate(desktop_records(document, file.parent, scope_map=mapping)):
        if index < after: continue
        if limit is not None and index >= after + limit: break
        result = api.call('/v1/import', record)
        for artifact_id, path in uploads: upload(api, artifact_id, path)
        duplicates += int(bool(result.get('duplicate')))
        completed = index + 1
        print(json.dumps({'completed': index + 1, 'duplicates': duplicates}), flush=True)
    # Only queue after all records and available file bytes were ingested. The
    # persisted import-step decision survives cancellation and retries.
    approved = metadata.get('review_approved') is True
    if approved and completed == preview['messages']:
        ids = [digest(record['event']['key']) for record, _ in desktop_records(document, file.parent, scope_map=mapping)]
        end = len(ids) if limit is None else min(len(ids), learning_after + limit)
        for start in range(learning_after, end, 500):
            api.call('/v1/memory/reviews', {'approved': True, 'batch': directory.name, 'event_ids': ids[start:min(end,start+500)]})
        learning_after = end
    result = {'completed': completed, 'duplicates': duplicates, 'telegram_replies': 0, 'review_approved': approved}
    if limit is not None:
        result.update(learning_after=learning_after, complete=completed == preview['messages'] and (not approved or learning_after == preview['messages']))
    return result
