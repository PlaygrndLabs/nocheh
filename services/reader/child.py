"""One file, read by nocheh-reader in a process of its own (ADR-0285).

It gets the file's bytes on stdin and its kind and hint as arguments, and writes one JSON line and then the bytes it
made, if any, on stdout. It holds no key and reaches no network; what it parses is the attacker's to choose, so all it
gives back is text, or a picture or recording it encoded itself:

- document: the text, read by Hermes's own document reader (services/hermes/document_text.py read()).
- image: the picture decoded and encoded again as a PNG of at most MAX_SIDE pixels a side, turned the way its EXIF says.
- audio: the recording's length and its sound encoded again as mono Ogg Opus, without its metadata or any picture.
"""
import io
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

LIMIT = 50 * 1024 * 1024
MAX_SIDE = 2048
# A larger picture is refused before it is decoded.
MAX_PIXELS = 60_000_000
# The made PNG and recording stay below what the reader hands back.
MAX_OUTPUT = 32 * 1024 * 1024
# Within the reader's 150 seconds for a recording.
PROBE_SECONDS = 20
AUDIO_SECONDS = 120


def document(data, hint):
    from services.hermes.document_text import answer
    return answer(data, hint), b''


def image(data, hint):
    import warnings
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            # Pillow only warns between MAX_PIXELS and twice that; any picture above it is refused.
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as found:
                found.load()
                picture = ImageOps.exif_transpose(found)
                picture = picture.convert('RGBA' if picture.mode in ('RGBA', 'LA', 'PA') or 'transparency' in picture.info else 'RGB')
                picture.thumbnail((MAX_SIDE, MAX_SIDE))
                made = io.BytesIO()
                picture.save(made, 'PNG')
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return {'state': 'too_large'}, b''
    except Exception:
        return {'state': 'unreadable'}, b''
    if made.tell() > MAX_OUTPUT:
        return {'state': 'too_large'}, b''
    return {'state': 'done', 'format': 'png', 'width': picture.width, 'height': picture.height}, made.getvalue()


def audio(data, hint):
    from services.hermes.voice_text import suffix
    kind = suffix(hint)
    if not kind:
        return {'state': 'unsupported'}, b''
    with tempfile.TemporaryDirectory(prefix='audio-') as work:
        source, made = Path(work, 'in' + kind), Path(work, 'out.ogg')
        source.write_bytes(data)
        try:
            found = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(source)],
                                   capture_output=True, text=True, timeout=PROBE_SECONDS, check=False, stdin=subprocess.DEVNULL).stdout.strip()
            seconds = float(found)
            seconds = seconds if math.isfinite(seconds) and seconds >= 0 else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            seconds = None
        try:
            ended = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(source), '-vn', '-sn', '-dn', '-map_metadata', '-1',
                                    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', str(made)],
                                   capture_output=True, timeout=AUDIO_SECONDS, check=False, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {'state': 'too_large'}, b''
        if ended.returncode or not made.is_file():
            return {'state': 'unsupported'}, b''
        if made.stat().st_size > MAX_OUTPUT:
            return {'state': 'too_large'}, b''
        return {'state': 'done', 'format': 'ogg', 'seconds': seconds}, made.read_bytes()


KINDS = {'document': document, 'image': image, 'audio': audio}


def main(argv):
    kind, hint = argv[0], json.loads(argv[1])
    data = sys.stdin.buffer.read(LIMIT + 1)
    if len(data) > LIMIT:
        head, made = {'state': 'too_large'}, b''
    else:
        head, made = KINDS[kind](data, hint)
    out = sys.stdout.buffer
    out.write(json.dumps({**head, 'size': len(made)}, ensure_ascii=False).encode() + b'\n')
    out.write(made)
    out.flush()


if __name__ == '__main__':
    import logging
    logging.disable(logging.CRITICAL)
    main(sys.argv[1:])
