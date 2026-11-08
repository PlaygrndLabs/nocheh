"""Writes one checked page of a job's chat into the sealed box's /chat; runs there as uid 65533.

Usage: python3 -I /opt/box/box_put.py <name> <byte count> <sha256>, with the bytes on stdin.
Nothing is kept unless every byte arrived: a dropped connection must not leave a short part.
"""
import errno
import hashlib
import os
import re
import sys

# Exit code when /chat has no room for the file: final for this box, so the launcher stops filling it.
FULL=4
# Room a new part leaves free, so the manifest that counts the parts can always be written.
RESERVE=64*1024


def kept(final,size,expected):
    """Whether the part is already in /chat with exactly these bytes."""
    try:
        with open(final,'rb',opener=lambda path,flags:os.open(path,flags|os.O_NOFOLLOW)) as file:
            return os.fstat(file.fileno()).st_size==size and hashlib.file_digest(file,'sha256').hexdigest()==expected
    except FileNotFoundError:return False


def main(argv,chat='/chat',stdin=0):
    # docker exec starts with umask 0000; box commands (uid 65532) must not change these files.
    os.umask(0o022)
    if len(argv)!=3 or not re.fullmatch(r'part-\d{5}\.jsonl|manifest\.json',argv[0]) or not re.fullmatch(r'\d{1,10}',argv[1]) \
            or not re.fullmatch(r'[a-f0-9]{64}',argv[2]):return 2
    name,size,expected=argv[0],int(argv[1]),argv[2]
    temp=os.path.join(chat,'.'+name+'.'+os.urandom(8).hex());final=os.path.join(chat,name)
    if name!='manifest.json':
        room=os.statvfs(chat)
        # The launcher writes a part again when it could not tell that the first write was kept; that one needs no room.
        if room.f_bavail*room.f_frsize<size+RESERVE:return 0 if kept(final,size,expected) else FULL
    try:
        descriptor=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o444)
        digest=hashlib.sha256();count=0
        with os.fdopen(descriptor,'wb') as file:
            while chunk:=os.read(stdin,min(1<<16,size+1-count) or 1):
                count+=len(chunk);digest.update(chunk)
                if count>size:return 3
                file.write(chunk)
        if count!=size or digest.hexdigest()!=expected:return 3
        # A part is never replaced; the manifest is, and only after its parts.
        if name=='manifest.json':os.replace(temp,final)
        else:
            try:os.link(temp,final)
            except FileExistsError:
                if not kept(final,size,expected):return 3
        return 0
    except OSError as error:
        if error.errno!=errno.ENOSPC:raise
        return FULL
    finally:
        try:os.unlink(temp)
        except FileNotFoundError:pass


if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
