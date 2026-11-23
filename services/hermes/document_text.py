"""Text of a document for Nocheh's preparation step, read by Hermes's own reader.

Nocheh keeps the original file and checks this text for secrets; this only reads it.
Word and Excel use Hermes's built-in readers; PowerPoint, old Office, OpenDocument,
RTF, EPUB and PDF use the converter Hermes bundles. No hosted text recognition runs,
so scanned pages say their text is missing. The file is parsed by nocheh-reader, away from
Hermes's keys and network, in a process and login of its own (ADR-0285); only its text comes
back. A read that fails because a write found no room or was refused is counted for the
owner's problem notice.
"""
import base64
import re
from pathlib import PurePosixPath

from . import reader_client, usage

LIMIT = 50 * 1024 * 1024
TEXT_LIMIT = 1_000_000
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
    result, _ = reader_client.read('document', data, hint)
    if result.get('state') not in ('done', 'scanned', 'unreadable', 'unsupported', 'too_large'):
        result = {'state': 'unreadable'}
    if result.get('write_failure') in usage.WRITE_FAILURES:
        usage.reader_failed('document', result['write_failure'])
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

