"""Fetches one GitHub branch into a git bundle, in a fresh fetcher container from the box image (ADR-0209).

github.py creates the container with no mounts and no environment, as uid 65530, and sends one JSON request on
stdin: {"repo","branch","commit","authorization","ip","limits":{"bundle","files","file","room","inodes"}}, plus
"base" in fixture mode. Only step 2 holds the key: a child process alone reads stdin and runs the fetch. Every later
git call, where git parses the objects in depth, runs with an environment that has no Authorization entry, and its
parent never held the key.

stdout carries the framing: a 4-byte big-endian length, that many bytes of JSON metadata
{commit,objects,files,dirs,largest,pages,index}, then the bundle. Nothing goes to stderr; git's stderr is read here
only to choose the exit code.

Usage: python3 -I /opt/box/repo_fetch.py (the fetcher), and python3 -I /opt/box/repo_fetch.py fetch <root> (its step 2).
"""
import base64
import errno
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import time

# The bounds of a copy (ADR-0209 §0). Same numbers and patterns as github.py, box_repo.py, security_launcher.py and
# background-jobs.ts; a parity test reads them.
MAX_BUNDLE=64*1024**2
MAX_FILES=50000
MAX_FILE=64*1024**2
REPO_ROOM=256*1024**2
REPO_INODES=65536
REPO_RESERVE=8*1024**2
PAGE=4096
FSCK_IGNORE=('zeroPaddedFilemode',)
NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')
BRANCH=re.compile(r'[A-Za-z0-9._/-]{1,255}')
COMMIT=re.compile(r'[a-f0-9]{40}')
BASE='https://github.com'
# A fixture's git base: plain http to a test server, never with userinfo, a query or a fragment.
FIXTURE_BASE=re.compile(r'https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._-]+)*')
# The fetcher ends its own work this long after it starts, inside github.py's FETCH_SECONDS watchdog.
SECONDS=140
REQUEST_BYTES=8192
LIMITS={'bundle':MAX_BUNDLE,'files':MAX_FILES,'file':MAX_FILE,'room':REPO_ROOM,'inodes':REPO_INODES}

DONE,BAD_REQUEST,KEY_REFUSED,NOT_READABLE,TOO_LARGE,REFUSED,FAILED,MOVED=0,2,10,11,12,13,14,15


class Stop(Exception):
    def __init__(self,code):super().__init__(code);self.code=code


def repo_name(value):
    return type(value) is str and bool(NAME.fullmatch(value)) and value.split('/')[1] not in ('.','..') and not value.endswith('.git')


def repo_branch(value):
    # '@{' needs no check: neither character is in the class.
    return type(value) is str and bool(BRANCH.fullmatch(value)) and not re.search(r'\.\.|//|^[-/.]|[/.]$|\.lock$',value)


def need(bundle,pages,index,objects):
    """The bytes a copy needs in /repo: the bundle and the pack it becomes, or the pack and the checkout, plus the
    pack's .idx and .rev, and the reserve."""
    return bundle+max(bundle,pages+index)+4096+32*objects+REPO_RESERVE


def measure(listing):
    """files, dirs, largest, pages and index of a tip, from `git ls-tree -r -l -z --full-tree` output."""
    files=largest=pages=gitlinks=0;index=4096;folders=set()
    for entry in listing.split(b'\0'):
        if not entry:continue
        meta,path=entry.split(b'\t',1);_,kind,_,size=meta.split()
        index+=128+2*len(path);parts=path.split(b'/')
        folders.update(b'/'.join(parts[:n]) for n in range(1,len(parts)))
        # A gitlink becomes an empty folder.
        if kind==b'commit':gitlinks+=1;continue
        if kind!=b'blob':raise ValueError('unexpected_tree_entry')
        size=int(size);files+=1;largest=max(largest,size)
        # tmpfs takes a whole page for every file that is not empty.
        if size:pages+=-(-size//PAGE)*PAGE
    return {'files':files,'dirs':len(folders)+gitlinks,'largest':largest,'pages':pages,'index':index}


def environment(root,config):
    """An explicit git environment, never inherited: no system or global configuration and no prompts."""
    env={'PATH':'/usr/bin:/bin','HOME':root,'TMPDIR':root,'LANG':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1',
         'GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':str(len(config))}
    for number,(key,value) in enumerate(config):env['GIT_CONFIG_KEY_%d'%number]=key;env['GIT_CONFIG_VALUE_%d'%number]=value
    return env


# Transfer fsck stays off: its verdict differs between git versions. Step 4 runs one explicit fsck instead.
PLAIN=[('protocol.allow','never'),('credential.helper',''),*(('fsck.'+name,'ignore') for name in FSCK_IGNORE),
       ('core.hooksPath','/dev/null'),('gc.auto','0'),
       # The fetcher has one CPU and 1 GiB.
       ('pack.threads','1'),('index.threads','1'),('core.deltaBaseCacheLimit','32m')]


def plain(root):return environment(root,PLAIN)


def fetch_environment(root,request):
    """The plain environment plus the key, sent only to the git base, and the pinned github.com address."""
    base=request.get('base',BASE)
    config=[*PLAIN,('http.'+base+'/.extraHeader','Authorization: Basic '+request['authorization']),('http.followRedirects','false')]
    if 'base' in request:config.append(('protocol.'+base.split(':',1)[0]+'.allow','always'))
    else:config+=[('http.curloptResolve','github.com:443:'+request['ip']),('protocol.https.allow','always')]
    return environment(root,config)


def checked(request,secret):
    """The request, or ValueError. Without `secret`, the child's answer: the request without authorization and ip."""
    if not isinstance(request,dict):raise ValueError('invalid_request')
    keys={'repo','branch','commit','limits'}|({'authorization','ip'} if secret else set())|({'base'} if 'base' in request else set())
    limits=request.get('limits')
    if set(request)!=keys or not repo_name(request['repo']) or not repo_branch(request['branch']) \
            or not (type(request['commit']) is str and COMMIT.fullmatch(request['commit'])) or not isinstance(limits,dict) \
            or set(limits)!=set(LIMITS) or not all(type(limits[k]) is int and 0<limits[k]<=LIMITS[k] for k in LIMITS):
        raise ValueError('invalid_request')
    if 'base' in request and not (type(request['base']) is str and FIXTURE_BASE.fullmatch(request['base'])):raise ValueError('invalid_request')
    if secret:
        authorization,ip=request['authorization'],request['ip']
        if not (type(authorization) is str and 0<len(authorization)<=1024 and re.fullmatch(r'[A-Za-z0-9+/]+={0,2}',authorization)):
            raise ValueError('invalid_request')
        base64.b64decode(authorization,validate=True)
        if 'base' in request:
            if ip is not None:raise ValueError('invalid_request')
        elif not (type(ip) is str and ipaddress.IPv4Address(ip).is_global):raise ValueError('invalid_request')
    return request


def refusal(stderr):
    """The exit code for a failed fetch, from git's own words; they are never printed."""
    text=stderr.decode('utf-8','replace')
    # git never prints 401: a refused key makes it ask for a user name, which it may not.
    if 'could not read Username' in text or 'Authentication failed' in text:return KEY_REFUSED
    if re.search(r'returned error: (?:30[0-9]|403|404)\b',text) or 'not found' in text:return NOT_READABLE
    return FAILED


def child(root):
    """Step 2, the only step that holds the key: reads the request and fetches the branch."""
    deadline=time.monotonic()+SECONDS-5;data=b''
    try:
        while len(data)<=REQUEST_BYTES and b'\n' not in data:
            chunk=os.read(0,4096)
            if not chunk:break
            data+=chunk
        if len(data)>REQUEST_BYTES:return BAD_REQUEST
        request=checked(json.loads(data.split(b'\n',1)[0]),True)
    except Exception:
        return BAD_REQUEST
    branch=request['branch']
    command=['git','-C',root+'/r.git','fetch','-q','--no-tags','--no-recurse-submodules','--no-write-fetch-head',
             request.get('base',BASE)+'/'+request['repo']+'.git','+refs/heads/%s:refs/heads/%s'%(branch,branch)]
    try:
        result=subprocess.run(command,env=fetch_environment(root,request),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE,timeout=max(.1,deadline-time.monotonic()))
    except Exception:
        return FAILED
    if result.returncode==-signal.SIGXFSZ:return TOO_LARGE
    if result.returncode:return refusal(result.stderr)
    del request['authorization'],request['ip']
    sys.stdout.write(json.dumps(request)+'\n');sys.stdout.flush()
    return DONE


def main(stdin,out,root='/fetch'):
    """Steps 1 and 3-8. Never reads stdin: the step-2 child does, from this same descriptor."""
    started=time.monotonic();env=plain(root);repository=root+'/r.git'
    def left():
        remaining=SECONDS-(time.monotonic()-started)
        if remaining<=0:raise Stop(FAILED)
        return remaining
    def git(*args,code=FAILED,output=False):
        try:
            result=subprocess.run(['git','-C',repository,*args],env=env,stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE if output else subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=left())
        except subprocess.TimeoutExpired:raise Stop(FAILED) from None
        # The fetcher's fsize limit stops a git that writes more than any copy may hold.
        if result.returncode==-signal.SIGXFSZ:raise Stop(TOO_LARGE)
        if result.returncode:raise Stop(code)
        return result.stdout
    try:
        result=subprocess.run(['git','init','-q','--bare','--template=',repository],env=env,stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=left())
        if result.returncode:return FAILED
        fetched=subprocess.run([sys.executable,'-I',os.path.abspath(__file__),'fetch',root],env=env,stdin=stdin,
                               stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=left())
        if fetched.returncode:return fetched.returncode if fetched.returncode in (BAD_REQUEST,KEY_REFUSED,NOT_READABLE,TOO_LARGE) else FAILED
        request=checked(json.loads(fetched.stdout.split(b'\n',1)[0]),False)
        branch,commit,limits=request['branch'],request['commit'],request['limits'];ref='refs/heads/'+branch
        # 3. The tip GitHub's API named, in a sha1 repository.
        if git('rev-parse','--show-object-format',output=True).strip()!=b'sha1':return REFUSED
        if git('rev-parse','--verify','--quiet',ref,output=True).strip().decode()!=commit:return MOVED
        if git('cat-file','-t',commit,code=REFUSED,output=True).strip()!=b'commit':return REFUSED
        # 4. One explicit strict check, the same on every git version and transport.
        git('fsck','--strict','--no-dangling','--no-reflogs','--no-progress',code=REFUSED)
        # 5. The tip's files, folders and pages, and the objects the branch reaches.
        try:tip=measure(git('ls-tree','-r','-l','-z','--full-tree',commit,code=REFUSED,output=True))
        except ValueError:return REFUSED
        objects=int(git('rev-list','--objects','--count',ref,output=True))
        if tip['files']>limits['files'] or tip['largest']>limits['file'] or tip['files']+tip['dirs']+1024>limits['inodes']:return TOO_LARGE
        # 6. The bundle holds what the branch reaches, and nothing else.
        bundle=root+'/out.bundle'
        git('bundle','create','-q',bundle,ref)
        size=os.path.getsize(bundle)
        if size>limits['bundle']:return TOO_LARGE
        # 7. The copy must fit in the box's /repo.
        if need(size,tip['pages'],tip['index'],objects)>limits['room']:return TOO_LARGE
        # 8. The framing, then the bundle.
        meta=json.dumps({'commit':commit,'objects':objects,**tip}).encode()
        out.write(len(meta).to_bytes(4,'big')+meta)
        with open(bundle,'rb') as file:
            while chunk:=file.read(1<<20):out.write(chunk)
        out.flush()
        return DONE
    except Stop as stop:
        return stop.code
    except OSError as error:
        return TOO_LARGE if error.errno in (errno.ENOSPC,errno.EFBIG) else FAILED
    except Exception:
        return FAILED


if __name__=='__main__':
    if sys.argv[1:2]==['fetch'] and len(sys.argv)==3 and os.path.isabs(sys.argv[2]):raise SystemExit(child(sys.argv[2]))
    if len(sys.argv)!=1:raise SystemExit(BAD_REQUEST)
    raise SystemExit(main(0,sys.stdout.buffer))
