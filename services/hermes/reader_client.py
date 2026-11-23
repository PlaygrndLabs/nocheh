"""Hermes's side of nocheh-reader (ADR-0285): a file's bytes go there over its Unix socket, and only text, or a picture or
recording the reader encoded itself, comes back. A reader that cannot be reached, or has no free login in time, raises
ReaderUnavailable, which Hermes answers with 503, so Nocheh's preparation tries the file again later."""
import json
import os
import socket

from services.reader.server import HEAD, MADE, SECONDS, WAIT

SOCKET = 'NOCHEH_READER_SOCKET'
# What a made file must start with, checked before Hermes hands it on.
MAGIC = {'png': b'\x89PNG\r\n\x1a\n', 'ogg': b'OggS'}
# The reader's answers that mean "try again later", not "this file cannot be read".
LATER = ('busy', 'unavailable', 'invalid_request')


class ReaderUnavailable(Exception):
    pass


def path():
    return os.environ.get(SOCKET, '/run/reader/reader.sock')


def read(kind, data, hint):
    """The reader's answer for one file: its head (state, and text or the made file's format) and the bytes it made."""
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(WAIT + SECONDS[kind] + 30)
            connection.connect(path())
            head = {'kind': kind, 'hint': {key: value for key, value in hint.items() if isinstance(value, str)}, 'size': len(data)}
            connection.sendall(json.dumps(head).encode() + b'\n' + data)
            stream = connection.makefile('rb')
            answer = json.loads(stream.readline(HEAD))
            size = answer.get('size') if isinstance(answer, dict) else None
            if type(size) is not int or not 0 <= size <= MADE:
                raise ReaderUnavailable('invalid answer')
            made = stream.read(size)
    except (OSError, ValueError) as error:
        raise ReaderUnavailable(type(error).__name__) from None
    if len(made) != size:
        raise ReaderUnavailable('short answer')
    if answer.get('state') == 'failed' and answer.get('reason') in LATER:
        raise ReaderUnavailable(answer['reason'])
    if (made or 'format' in answer) and not made.startswith(MAGIC.get(answer.get('format'), b'\0' * 8)):
        return {'state': 'unreadable'}, b''
    return answer, made
