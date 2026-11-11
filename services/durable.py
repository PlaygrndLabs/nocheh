"""Durable file helpers shared by Nocheh's Python services: canonical JSON, digests and write-once files."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable_file(directory: Path, name: str, data: bytes):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / name
    temporary = directory / ('.' + uuid.uuid4().hex + '.tmp')
    created = True
    try:
        with temporary.open('xb') as file:
            os.chmod(temporary, 0o600)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            created = False
            if target.read_bytes() != data:
                raise RuntimeError('immutable_capture_conflict') from None
        sync_directory(directory)
        return created
    finally:
        temporary.unlink(missing_ok=True)
