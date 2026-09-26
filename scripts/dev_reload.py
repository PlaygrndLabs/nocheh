"""Restart one development process when mounted Python or generated code changes."""

import argparse
import os
import signal
import subprocess
import time
from pathlib import Path

SUFFIXES = {'.py', '.js', '.mjs', '.json', '.css', '.html'}


def snapshot(paths):
    result = []
    for root in paths:
        for path in root.rglob('*') if root.is_dir() else (root,):
            if path.suffix not in SUFFIXES or {'node_modules', 'dist', '__pycache__'} & set(path.parts):
                continue
            try:
                if path.is_file():
                    info = path.stat()
                    result.append((str(path), info.st_size, info.st_mtime_ns))
            except OSError:
                continue  # An editor may replace a file while scanning.
    return tuple(sorted(result))


def stop(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch', action='append', required=True, type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a child command is required')
    stopping = False

    def terminate(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    previous = snapshot(args.watch)
    child = subprocess.Popen(command, start_new_session=True)
    try:
        while not stopping:
            time.sleep(.75)
            current = snapshot(args.watch)
            if current != previous or child.poll() is not None:
                previous = current
                print('Development source changed; restarting process', flush=True)
                stop(child)
                if not stopping:
                    child = subprocess.Popen(command, start_new_session=True)
    finally:
        stop(child)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
