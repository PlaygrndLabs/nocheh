"""Write src/confusables.ts from Unicode's confusables.txt (UTS #39), so an approval card can tell when two
keys of one input read alike. Run it again when Unicode publishes a new version:

    curl -sSO https://www.unicode.org/Public/security/latest/confusables.txt
    python3 -m tools.development.confusables confusables.txt
"""
from tools.paths import ROOT
from collections import defaultdict
from pathlib import Path
import re
import sys

NOTICE = '''UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-{year} Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.'''


def hex_codes(field):
    return '.'.join(format(int(code, 16), 'x') for code in field.split())


def main(source):
    text = Path(source).read_text(encoding='utf-8-sig')
    version = re.search(r'^# Version: (\S+)', text, re.M).group(1)
    year = re.search(r'^# © (\d{4}) Unicode', text, re.M).group(1)
    groups = defaultdict(list)
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if not line: continue
        drawn, prototype = (field.strip() for field in line.split(';')[:2])
        groups[hex_codes(prototype)].append(hex_codes(drawn))
    notice = '\n'.join(f' * {line}'.rstrip() for line in NOTICE.format(year=year).splitlines())
    body = ',\n'.join(f"  '{prototype}:{' '.join(drawn)}'" for prototype, drawn in sorted(groups.items()))
    (ROOT / 'src/confusables.ts').write_text(f'''// Written by tools/development/confusables.py from Unicode's confusables.txt (UTS #39), version {version}.
/* The data comes with this notice:
 *
{notice}
 */

/** Each prototype's code points, joined by ., then : and the characters drawn as it, in hexadecimal. */
export const confusables=[
{body},
].join(';');
''')


if __name__ == '__main__':
    main(sys.argv[1])
