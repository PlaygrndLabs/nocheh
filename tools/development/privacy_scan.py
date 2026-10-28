"""Refuse to publish the owner's private details: names, provider gateway, hosting, devices, domains.

The words to refuse live in a private file outside Git, one per line; `regex:` starts a regular
expression. Plain words match whole words, ignoring case. The file is looked for in
$NOCHEH_PRIVATE_TERMS_FILE, then data/privacy-terms.txt. Without it the scan fails, so a push
can't pass unchecked.

    python3 -m tools.development.privacy_scan              # commits not yet on origin/main
    python3 -m tools.development.privacy_scan --range A..B # authors, commit messages and added lines
    python3 -m tools.development.privacy_scan --tree       # every tracked file at HEAD
"""
from tools.paths import ROOT
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


def terms_file():
    for candidate in (os.environ.get('NOCHEH_PRIVATE_TERMS_FILE'), ROOT / 'data/privacy-terms.txt'):
        if candidate and Path(candidate).is_file(): return Path(candidate)
    return None


def patterns(path):
    result = []
    for number, line in enumerate(Path(path).read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'): continue
        result.append((number, re.compile(line[6:] if line.startswith('regex:') else r'(?<![\w.@-])' + re.escape(line) + r'(?![\w@-])',
                                 re.IGNORECASE)))
    return result


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True, text=True, errors='replace').stdout


def findings(text, where, compiled):
    """Where a private word appears, by its line in the word list, without printing the word itself."""
    hits = []
    for number, line in enumerate(text.splitlines(), 1):
        for index, pattern in compiled:
            if pattern.search(line): hits.append(f'{where}:{number}: private word on list line {index}')
    return hits


def scan_range(span, compiled):
    hits = []
    for commit in git('rev-list', *span.split()).split():
        short = commit[:10]
        hits += findings(git('log', '-1', '--format=%B', commit), f'{short} message', compiled)
        hits += findings(git('log', '-1', '--format=%an <%ae>%n%cn <%ce>', commit), f'{short} author', compiled)
        current = None
        for line in git('show', '--format=', '--unified=0', '--no-color', commit).splitlines():
            if line.startswith('+++ '): current = line[6:] if line.startswith('+++ b/') else line[4:]
            elif line.startswith('+') and current:
                hits += findings(line[1:], f'{short} {current}', compiled)
    return hits


def scan_tree(compiled):
    hits = []
    for name in git('ls-files', '-z').split('\0'):
        path = ROOT / name
        if not name or not path.is_file() or path.is_symlink(): continue
        data = path.read_bytes()
        if b'\0' in data[:8192]: continue
        hits += findings(data.decode('utf-8', 'replace'), name, compiled)
        hits += findings(name, name + ' (path)', compiled)
    return hits


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--range', help='Commits to check as rev-list arguments, such as origin/main..HEAD')
    parser.add_argument('--tree', action='store_true', help='Check every tracked file at HEAD instead')
    args = parser.parse_args(argv)
    path = terms_file()
    if not path:
        print('privacy scan: no private word list found (set NOCHEH_PRIVATE_TERMS_FILE or add data/privacy-terms.txt)', file=sys.stderr)
        return 2
    compiled = patterns(path)
    hits = scan_tree(compiled) if args.tree else scan_range(args.range or 'origin/main..HEAD', compiled)
    for hit in hits: print(hit, file=sys.stderr)
    if hits:
        print(f'privacy scan: {len(hits)} private word(s) found; replace them with neutral wording before publishing', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
