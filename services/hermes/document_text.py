"""Text of a document for Nocheh's preparation step, read by Hermes's own reader.

Nocheh keeps the original file and checks this text for secrets; this only reads it.
Word and Excel use Hermes's built-in readers; PowerPoint, old Office, OpenDocument,
RTF, EPUB and PDF use the converter Hermes bundles. No hosted text recognition runs,
so scanned pages say their text is missing. Each file is read in a child process with
no service credentials, bounded in time and memory, so a broken or hostile file can
only fail its own reading. The child's home and temporary files are in a folder of its
own that is removed after every read, timeouts included: /tmp is memory in the
locked-down container (ADR-0251). A read that fails because a write found no room or
was refused is counted for the owner's problem notice.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import PurePosixPath

from . import usage

LIMIT = 50 * 1024 * 1024
TEXT_LIMIT = 1_000_000
SECONDS = 120
MEMORY = 2 * 1024 * 1024 * 1024
SCANNED = '[Some pages are scanned images; their text is not included here. The original file is kept.]\n'
# Hermes writes these notes for its own agent; Nocheh's readers get a plain one instead.
AGENT_NOTES = re.compile(r'\A\[(?:EXTRACTION COVERAGE WARNING|NEEDS OCR):.*?\]\n', re.S)
MIME = {'application/pdf': '.pdf', 'application/msword': '.doc', 'application/rtf': '.rtf', 'text/rtf': '.rtf',
        'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt', 'application/epub+zip': '.epub',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
        'application/vnd.oasis.opendocument.text': '.odt', 'application/vnd.oasis.opendocument.spreadsheet': '.ods',
        'application/vnd.oasis.opendocument.presentation': '.odp'}


def extract(body):
    data = base64.b64decode(body['bytes_base64'], validate=True)
    if len(data) > LIMIT:
        return {'state': 'too_large'}
    hint = {'name': body.get('name') if isinstance(body.get('name'), str) else '',
            'mime_type': body.get('mime_type') if isinstance(body.get('mime_type'), str) else ''}

    def bounded():
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY, MEMORY))
    failure = None
    try:
        with tempfile.TemporaryDirectory(prefix='nocheh-document-', ignore_cleanup_errors=True) as home:
            environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONPATH': os.environ.get('PYTHONPATH', ''),
                           'HOME': home, 'TMPDIR': home}
            try:
                child = subprocess.run([sys.executable, '-m', 'services.hermes.document_text', json.dumps(hint)], input=data,
                                       capture_output=True, timeout=SECONDS, env=environment, preexec_fn=bounded, check=False)
                result = json.loads(child.stdout)
            except (subprocess.TimeoutExpired, ValueError):
                result = None
            if not isinstance(result, dict) or result.get('state') not in ('done', 'scanned', 'unreadable', 'unsupported'):
                result = {'state': 'unreadable'}
            if result['state'] == 'unreadable':
                failure = result.get('write_failure') if result.get('write_failure') in usage.WRITE_FAILURES else \
                    'temp_full' if usage.temp_full(home, len(data)) else None
    except OSError as error:
        # Its folder could not be made: /tmp is full, which a restart of Hermes empties.
        failure = usage.write_failure(error)
        if failure is None:
            raise
        result = {'state': 'unreadable'}
    if failure:
        usage.reader_failed('document', failure)
    elif result['state'] in ('done', 'scanned'):
        usage.reader_done('document')
    return {key: value for key, value in result.items() if key in ('state', 'text')}


def suffix(name, mime_type, data, reader):
    """The document type from its name, its MIME type, or its first bytes."""
    for candidate in (PurePosixPath(name.replace('\\', '/')).suffix.lower(), MIME.get(mime_type.split(';')[0].strip().lower(), '')):
        if candidate and reader.is_extractable_document('document' + candidate):
            return candidate
    try:
        import anydoc
        found = anydoc.format_from_bytes(data)
        candidate = '.' + str(getattr(found, 'value', found)).lower()
    except Exception:
        return ''
    return candidate if reader.is_extractable_document('document' + candidate) else ''


def read(data, hint):
    from tools import read_extract as reader
    kind = suffix(hint.get('name', ''), hint.get('mime_type', ''), data, reader)
    if not kind:
        return {'state': 'unsupported'}
    try:
        text = reader.extract_document_bytes(data, 'document' + kind)
    except reader.ExtractionError as error:
        failure = usage.write_failure(error)
        if failure:
            return {'state': 'unreadable', 'write_failure': failure}
        return {'state': 'scanned' if 'NeedsOcrError' in str(error) else 'unreadable'}
    if AGENT_NOTES.match(text):
        text = SCANNED + AGENT_NOTES.sub('', text, count=1)
    if not text.strip():
        return {'state': 'unreadable'}
    if len(text) > TEXT_LIMIT:
        text = text[:TEXT_LIMIT] + '\n\n[The rest of this document is not included.]'
    return {'state': 'done', 'text': text}


def answer(data, hint):
    """The child's answer: a write that found no room or was refused says so; any other error fails the read."""
    try:
        return read(data, hint)
    except Exception as error:
        failure = usage.write_failure(error)
        if failure is None:
            raise
        return {'state': 'unreadable', 'write_failure': failure}


if __name__ == '__main__':
    print(json.dumps(answer(sys.stdin.buffer.read(LIMIT + 1), json.loads(sys.argv[1])), ensure_ascii=False))
