"""Trusted Compose launcher. Docker authority never enters an agent container."""
import contextlib
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import secrets
import select
import signal
import socket
import stat
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request,build_opener,ProxyHandler
from .isolated_profile import DATA_DIRS,DATA_FILES
from .environment import parallel

CONFIGURATION=('config.yaml','SOUL.md','skills')
BOX_NAME=re.compile(r'nocheh-box-[a-f0-9]{24}')
def security_url():return os.environ.get('NOCHEH_SECURITY_URL') or 'http://nocheh-security:8786'
def agent_network():return os.environ.get('NOCHEH_AGENT_NETWORK','nocheh-agent')

class DockerConnection(http.client.HTTPConnection):
    def __init__(self):super().__init__('localhost',timeout=240)
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout)
        self.sock.connect(os.environ.get('NOCHEH_DOCKER_SOCKET','/var/run/docker.sock'))

def docker(method,path,body=None):
    client=DockerConnection()
    try:
        client.request(method,'/v1.41'+path,body=None if body is None else json.dumps(body),headers={'Content-Type':'application/json'})
        response=client.getresponse();raw=response.read(2*1024*1024)
        if response.status not in (200,201,204,304):raise RuntimeError('container_operation_failed')
        return json.loads(raw) if raw else {}
    finally:client.close()

def container_spec(profile,host_root,image,network,uid,gid,source_root=None,box=None):
    if not re.fullmatch(r'nocheh-[a-f0-9]{24}',profile):raise ValueError('invalid_isolated_profile')
    if box is not None and not BOX_NAME.fullmatch(box):raise ValueError('invalid_job_box')
    root=Path(host_root)
    if not root.is_absolute() or any(c in str(root) for c in '\r\n,:'):raise ValueError('invalid_host_profile_root')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('pinned_runtime_image_required')
    if not re.fullmatch(r'[\w-]{1,128}',network):raise ValueError('invalid_isolation_network')
    if not all(type(x) is int and x>0 for x in (uid,gid)):raise ValueError('unprivileged_identity_required')
    # The owner's role (SOUL.md) and skills are configuration: readable, never writable by the turn.
    mounts=[{'Type':'bind','Source':str(root/profile/name),'Target':'/profile/'+name,'ReadOnly':True} for name in CONFIGURATION]
    mounts += [{'Type':'bind','Source':str(root/profile/name),'Target':'/profile/'+name,'ReadOnly':False} for name in DATA_DIRS]
    mounts += [{'Type':'bind','Source':str(root/profile/name),'Target':'/profile/'+name,'ReadOnly':False} for name in DATA_FILES]
    if source_root is not None:
        # Source-watched development only: turns use the checkout's plugin code,
        # read-only, instead of the code baked into the pinned runtime image.
        source=Path(source_root)
        if not source.is_absolute() or any(c in str(source) for c in '\r\n,:'):raise ValueError('invalid_development_source')
        mounts += [{'Type':'bind','Source':str(source/name),'Target':'/workspace/'+name,'ReadOnly':True} for name in ('services','tools')]
    # A job's sealed box: the turn reaches it only through the box's socket, mounted read-only.
    if box is not None:mounts.append({'Type':'volume','Source':box,'Target':'/box','ReadOnly':True})
    return {'Image':image,'User':f'{uid}:{gid}','WorkingDir':'/workspace',
      'Cmd':['python','-m','services.hermes.assistant_turn'],
      'Env':['HOME=/tmp/home','HERMES_HOME=/profile','NOCHEH_CAPTURE_ENABLED=0','NOCHEH_ISOLATED_TURN=1',
             'ARCHIVE_URL=http://nocheh-security:8786','GUARD_URL=http://nocheh-security:8786',
             *(['TERMINAL_ENV=nocheh_box','TERMINAL_CWD=/work','NOCHEH_BOX_SOCKET=/box/exec.sock'] if box is not None else [])],
      'OpenStdin':True,'StdinOnce':True,'AttachStdin':True,'AttachStdout':True,'AttachStderr':False,'Tty':False,
      'Labels':{'nocheh.role':'isolated-turn','nocheh.profile':profile},
      'HostConfig':{'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
        'NetworkMode':network,'Dns':['127.0.0.1'],'Mounts':mounts,'PidsLimit':128,'Memory':2*1024**3,'NanoCpus':2*10**9,
        'Tmpfs':{'/tmp':f'rw,nosuid,nodev,size=128m,uid={uid},gid={gid}',
                 '/profile':f'rw,nosuid,nodev,size=32m,uid={uid},gid={gid}'},
        'LogConfig':{'Type':'none'},'Init':True,
        # Docker removes an exited turn even if this launcher stopped mid-turn.
        'AutoRemove':True},
    }

def validate_local_profile(profile,root=Path('/profiles')):
    path=root/profile
    if path.is_symlink() or not path.is_dir() or path.parent.resolve()!=root.resolve():raise ValueError('profile_mount_denied')
    for name in (*CONFIGURATION,*DATA_DIRS,*DATA_FILES):
        item=path/name
        if item.is_symlink() or not item.exists() or not item.resolve().is_relative_to(path.resolve()):raise ValueError('profile_mount_denied')

def attach(identifier,body):
    client=DockerConnection()
    try:
        client.request('POST','/v1.41/containers/'+identifier+'/attach?stream=1&stdin=1&stdout=1&stderr=0',
                       headers={'Connection':'Upgrade','Upgrade':'tcp'})
        response=client.getresponse()
        if response.status!=101:raise RuntimeError('container_attach_failed')
        docker('POST','/containers/'+identifier+'/start')
        client.sock.sendall(json.dumps(body,ensure_ascii=False).encode());client.sock.shutdown(socket.SHUT_WR)
        size=0
        while header:=response.fp.read(8):
            if len(header)!=8 or header[0]!=1:raise RuntimeError('container_output_invalid')
            length=int.from_bytes(header[4:8],'big');size+=length
            if size>8*1024*1024:raise RuntimeError('container_output_limit')
            content=response.fp.read(length)
            if len(content)!=length:raise RuntimeError('container_output_invalid')
            yield content
    finally:client.close()

# Sealed job boxes (box contract sections 6 and 7). A box holds a job's /work across its runs
# and a read-only copy of the job's checked chat; it has no network, keys, binds or Docker socket.
BOX_KEY=('job','generation','mode','valid_from')
# Fill state of the boxes this launcher made, by container Id. Startup removes every other box of this installation.
BOXES={}
# Jobs whose last box turn did not end by itself with success (an error, a kill, a dropped client, a result that is
# not done): what it started in the box, such as a code cell, may still run there, so the job's next run gets a new box.
ABNORMAL=set()
# Box listing, creation and removal, and creating a turn that mounts a box, never interleave.
BOX_LOCK=threading.Lock()
# Seconds from a turn request to its box being made, /chat filled and the wait for /repo; the turn starts then even if
# either copy is incomplete, so the binding, the box and the fill stay well within security_client's 235 s wait for headers.
FILL_SECONDS=120
# The end of that time is kept for writing the last page read, so the manifest a turn reads counts every part.
WRITE_SECONDS=10
# Jobs running at once (RUNNING_JOBS in src/stores/background-jobs.ts): each must be able to have its box.
RUNNING_JOBS=2
# The broker's own cap on a /v1/box/chat page.
PAGE_BYTES=8*1024*1024
# A job's GitHub copy in its box's /repo (ADR-0209). Same numbers and patterns as github.py, repo_fetch.py, box_repo.py
# and background-jobs.ts; a parity test reads them.
MAX_BUNDLE=64*1024**2
REPO_ROOM=256*1024**2
REPO_INODES=65536
# A repo box's extra memory: /repo's pages, its inodes, and the writer's git beside the job's commands.
REPO_MEMORY=512*1024**2
REPO_UID=65531
# The most a writer may take; its writer time ends REPO_MARGIN before the run's hard deadline, so a copy lands while
# box tools still start (job_box.py's MARGIN+FLOOR). With less than REPO_FLOOR of it, no bundle is sent.
WRITER_SECONDS=600
REPO_MARGIN=60
REPO_FLOOR=60
# How long past the writer time the launcher waits for the writer's exec to end.
REPO_GRACE=15
# Sends of the bundle into one box, within one copy thread.
REPO_TRIES=2
REPO_NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')
REPO_BRANCH=re.compile(r'[A-Za-z0-9._/-]{1,255}')
COMMIT=re.compile(r'[a-f0-9]{40}')
DIGEST=re.compile(r'[a-f0-9]{64}')
REPO_KEYS=frozenset({'name','branch','commit','digest','bytes','need'})
# The pinned bundles, read-only; the launcher opens only the one a binding names.
REPO_COPIES='/repo-copies'
REPO_TMPFS=f'rw,noexec,nosuid,nodev,size={REPO_ROOM//1024**2}m,nr_inodes={REPO_INODES},uid={REPO_UID},gid={REPO_UID},mode=0755'
REPO_WRITER=['python3','-I','/opt/box/box_repo.py']
# Guards each box's repo entry: its state, its sends and its copy thread.
REPO_LOCK=threading.Lock()

def box_limit():
    limit=parallel('NOCHEH_BOX_LIMIT',2)
    if limit<RUNNING_JOBS:raise ValueError('Invalid NOCHEH_BOX_LIMIT')
    return limit

def box_image():return os.environ.get('NOCHEH_BOX_IMAGE','nocheh-box:local')

def box_token():
    token=os.environ.get('NOCHEH_BOX_TOKEN','')
    if len(token)<32:raise ValueError('box_token_required')
    return token

def security(path,headers,timeout,limit=8*1024*1024):
    with build_opener(ProxyHandler({})).open(Request(security_url()+path,headers=headers),timeout=timeout) as response:raw=response.read(limit+1)
    if len(raw)>limit:raise ValueError('security_response_limit')
    value=json.loads(raw)
    if not isinstance(value,dict):raise ValueError('security_response_invalid')
    return value

def expiry(value):
    try:moment=datetime.fromisoformat(value)
    except (TypeError,ValueError):return 0
    return moment.timestamp() if moment.tzinfo else 0

def box_labels(box):
    """The Docker labels of the box a binding (or a /v1/box/live entry) names; malformed means no box."""
    if not isinstance(box,dict):raise ValueError('invalid_job_box')
    job,generation,mode,epoch,expires=(box.get(k) for k in ('job','generation','mode','valid_from_epoch','expires'))
    if type(generation) is int and generation>=0:generation=str(generation)
    if not (type(job) is str and re.fullmatch(r'[a-f0-9]{64}',job) and type(generation) is str and re.fullmatch(r'[A-Za-z0-9-]{1,64}',generation)
            and mode=='on' and type(epoch) is int and epoch>=0 and type(expires) is str and len(expires)<=64 and expiry(expires)):raise ValueError('invalid_job_box')
    # The installation's agent network names whose box it is: a launcher touches only its own installation's boxes.
    return {'nocheh.role':'job-box','nocheh.box.network':agent_network(),'nocheh.box.job':job,'nocheh.box.generation':generation,'nocheh.box.mode':mode,
            'nocheh.box.valid_from':str(epoch),'nocheh.box.expires':expires}

def repo_name(value):
    return type(value) is str and bool(REPO_NAME.fullmatch(value)) and value.split('/')[1] not in ('.','..') and not value.endswith('.git')

def repo_branch(value):
    # '@{' needs no check: neither character is in the class.
    return type(value) is str and bool(REPO_BRANCH.fullmatch(value)) and not re.search(r'\.\.|//|^[-/.]|[/.]$|\.lock$',value)

def box_repo(box):
    """The GitHub copy a binding's box holds, or None; a malformed one means no box."""
    if 'repo' not in box:return None
    repo=box['repo']
    if not (isinstance(repo,dict) and set(repo)==REPO_KEYS and repo_name(repo['name']) and repo_branch(repo['branch'])
            and type(repo['commit']) is str and COMMIT.fullmatch(repo['commit']) and type(repo['digest']) is str and DIGEST.fullmatch(repo['digest'])
            and type(repo['bytes']) is int and 0<repo['bytes']<=MAX_BUNDLE and type(repo['need']) is int and 0<repo['need']<=REPO_ROOM):
        raise ValueError('invalid_job_box')
    return repo

def box_spec(image,gid,name,labels,repo=False):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('pinned_box_image_required')
    if not BOX_NAME.fullmatch(name):raise ValueError('invalid_job_box')
    if not (type(gid) is int and gid>0):raise ValueError('unprivileged_identity_required')
    spec={'Image':image,'User':'65532:65532','Cmd':['python3','-I','/opt/box/box_server.py'],
      'Env':[f'NOCHEH_BOX_GID={gid}','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8','HOME=/work'],'Labels':labels,
      'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
        'GroupAdd':[str(gid)],'Init':True,'PidsLimit':128,'Memory':1024**3,'MemorySwap':1024**3,'NanoCpus':10**9,
        'OomScoreAdj':1000,'IpcMode':'private','LogConfig':{'Type':'none'},
        'Ulimits':[{'Name':'nofile','Soft':1024,'Hard':1024},{'Name':'core','Soft':0,'Hard':0},
                   {'Name':'fsize','Soft':100*1024**2,'Hard':100*1024**2}],
        'Tmpfs':{'/work':'rw,exec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700',
                 '/tmp':'rw,noexec,nosuid,nodev,size=64m',
                 # Hermes cannot spill other tools' unchecked results into the box.
                 '/tmp/hermes-results':'ro,noexec,nosuid,nodev,size=64k',
                 # The chat copy belongs to uid 65533, so the box's commands can read but never change it.
                 '/chat':'rw,noexec,nosuid,nodev,size=128m,uid=65533,gid=65533,mode=0755'},
        # The socket volume is the box's only mount: turns, as NOCHEH_GID, reach the socket and nothing else.
        'Mounts':[{'Type':'volume','Source':name,'Target':'/run/box','ReadOnly':False}]}}
    if repo:
        # The copy belongs to the writer's uid 65531: box commands can read it but never change it. Its pages and
        # inodes count against the box's memory, which grows by REPO_MEMORY.
        spec['HostConfig']['Tmpfs']['/repo']=REPO_TMPFS
        spec['HostConfig']['Memory']=spec['HostConfig']['MemorySwap']=1024**3+REPO_MEMORY
    return spec

def volume_spec(name,gid,labels):
    # Box commands own the volume's root, so nothing they put there may run, be a device or carry setuid in the turn.
    return {'Name':name,'Driver':'local','Labels':{k:labels[k] for k in ('nocheh.role','nocheh.box.network','nocheh.box.job')},
            'DriverOpts':{'type':'tmpfs','device':'tmpfs','o':f'size=1m,uid=65532,gid={gid},mode=0710,nosuid,nodev,noexec'}}

def boxes():
    """This installation's boxes and socket volumes: only ones with the box label, this installation's network label
    and the box name are ever listed, counted or removed, so another copy of Nocheh on the same Docker keeps its boxes."""
    owned={'nocheh.role':'job-box','nocheh.box.network':agent_network()}
    def ours(labels):return all((labels or {}).get(k)==v for k,v in owned.items())
    labelled='filters='+quote(json.dumps({'label':[k+'='+v for k,v in owned.items()]}))
    containers=[c for c in docker('GET','/containers/json?all=true&'+labelled) if ours(c.get('Labels'))
                and len(c.get('Names') or [])==1 and BOX_NAME.fullmatch(c['Names'][0][1:])]
    volumes=[v['Name'] for v in docker('GET','/volumes?'+labelled).get('Volumes') or [] if ours(v.get('Labels')) and BOX_NAME.fullmatch(v['Name'])]
    return containers,volumes

def remove_box(identifier,name=None):
    BOXES.pop(identifier,None)
    for path in ('/containers/'+identifier+'?force=true',*(['/volumes/'+name] if name else [])):
        # A volume a turn still mounts stays until a later sweep.
        try:docker('DELETE',path)
        except Exception:pass

def kept(labels,current,now):
    """Whether a box may stay: before its expiry and, when /v1/box/live answered (current), listed with its labels."""
    if expiry(labels.get('nocheh.box.expires'))<=now:return False
    if current is None:return True
    key=tuple(labels.get('nocheh.box.'+k) for k in BOX_KEY)
    return key in current and expiry(current[key])>now

def sweep(live):
    """Keep a box only while it runs and kept() allows it.
    live() returns {key: expires}, None when /live is down but not yet for long, or {} to remove every box."""
    with BOX_LOCK:found,volumes=boxes()
    current=live();now=time.time()
    keep={c['Names'][0][1:] for c in found if c.get('State')=='running' and kept(c['Labels'],current,now)}
    with BOX_LOCK:
        for c in found:
            if c['Names'][0][1:] not in keep:remove_box(c['Id'])
        for name in volumes:
            if name not in keep:
                try:docker('DELETE','/volumes/'+name)
                except Exception:pass

def live_boxes(timeout=10):
    entries=security('/v1/box/live',{'Authorization':'Bearer '+box_token()},timeout)['boxes']
    if not isinstance(entries,list):raise ValueError('security_response_invalid')
    current={}
    for entry in entries:
        with contextlib.suppress(ValueError):
            labels=box_labels(entry);current[tuple(labels['nocheh.box.'+k] for k in BOX_KEY)]=labels['nocheh.box.expires']
    return current

def sweeper(interval=15,outage=120,stopped=None):
    """Every interval: remove boxes /v1/box/live no longer lists; after outage seconds without an answer, all boxes."""
    stopped=stopped or threading.Event();answered=time.monotonic()
    def live():
        nonlocal answered
        try:current=live_boxes()
        except Exception:return {} if time.monotonic()-answered>=outage else None
        answered=time.monotonic();return current
    while not stopped.wait(interval):
        with contextlib.suppress(Exception):sweep(live)

def exec_stdin(identifier,command,user,source,until):
    """Runs a fixed command in a box as `user` with no added environment and `source` (bytes, or a binary file sent
    in 1 MiB chunks) only on stdin. Returns its exit code once it ended by `until`, else None; never kills it."""
    execution=docker('POST','/containers/'+identifier+'/exec',{'User':user,'WorkingDir':'/','Env':[],'Cmd':command,
        'AttachStdin':True,'AttachStdout':True,'AttachStderr':True,'Tty':False})['Id']
    client=DockerConnection();client.timeout=max(.1,until-time.monotonic());writer=None;sane=True
    try:
        client.request('POST','/v1.41/exec/'+execution+'/start',body=json.dumps({'Detach':False,'Tty':False}),
                       headers={'Content-Type':'application/json','Connection':'Upgrade','Upgrade':'tcp'})
        response=client.getresponse()
        if response.status!=101:raise RuntimeError('box_exec_failed')
        def write():
            # From a thread: the command may stop reading early, and a blocked send must not hold the stream.
            with contextlib.suppress(OSError):
                if isinstance(source,bytes):client.sock.sendall(source)
                else:
                    while chunk:=source.read(1<<20):client.sock.sendall(chunk)
                client.sock.shutdown(socket.SHUT_WR)
        writer=threading.Thread(target=write,daemon=True);writer.start();size=0
        try:
            while header:=response.fp.read(8):
                if len(header)!=8 or header[0] not in (1,2):sane=False;break
                length=int.from_bytes(header[4:8],'big');size+=length
                if size>64*1024 or len(response.fp.read(length))!=length:sane=False;break
        except OSError:pass  # The stream ended; the exec's own state says how the command ended.
    finally:
        with contextlib.suppress(Exception):client.sock.shutdown(socket.SHUT_RDWR)
        client.close()
        if writer:writer.join(5)
    # Output that is not the command's own framing, or more of it than these commands write, gives no exit code.
    if not sane:return None
    state=docker('GET','/exec/'+execution+'/json')
    while state.get('Running') and time.monotonic()<until:
        time.sleep(.05);state=docker('GET','/exec/'+execution+'/json')
    return None if state.get('Running') else state.get('ExitCode')

def put(identifier,name,data,until):
    """Writes one /chat file through box_put: a fixed command as uid 65533 with no added environment,
    the chat bytes only on stdin, and the file kept only if box_put saw every byte. Never runs past until."""
    if time.monotonic()>=until:raise RuntimeError('box_fill_failed')
    command=['python3','-I','/opt/box/box_put.py',name,str(len(data)),hashlib.sha256(data).hexdigest()]
    try:code=exec_stdin(identifier,command,'65533:65533',data,until)
    except RuntimeError:raise RuntimeError('box_fill_failed') from None
    # box_put's FULL: /chat has no room for the file.
    if code==4:raise RuntimeError('box_chat_full')
    if code!=0:raise RuntimeError('box_fill_failed')

def manifest(state):
    return json.dumps({k:state[k] for k in ('complete','next','parts','records','checking','full')}).encode()

def jsonl(record):
    line=json.dumps(record,ensure_ascii=False,separators=(',',':'))
    try:return line.encode()+b'\n'
    except UnicodeEncodeError:return json.dumps(record,separators=(',',':')).encode()+b'\n'

def chat_page(credential,cursor,until):
    page=security('/v1/box/chat'+('' if cursor is None else '?cursor='+quote(cursor,safe='')),
                  {'Authorization':'Bearer '+credential,'X-Nocheh-Box-Token':box_token()},max(.1,min(60,until-time.monotonic())),PAGE_BYTES)
    records,following,checking,complete=(page.get(k) for k in ('records','next','checking','complete'))
    if not (isinstance(records,list) and len(records)<=200 and all(isinstance(r,dict) for r in records) and type(complete) is bool
            and (following is None and complete or type(following) is str and 0<len(following)<=4096) and type(checking) is int and checking>=0):
        raise ValueError('box_chat_invalid')
    return records,following,checking,complete

def write_part(identifier,state,until):
    # A part whose write failed is written again, under its own name and with the same lines, before anything else:
    # box_put keeps an identical part that is already there, so no record is in /chat twice and parts counts its files.
    fresh=state['pending']
    put(identifier,'part-%05d.jsonl'%(state['parts']+1),b''.join(fresh.values()),until)
    state.update(parts=state['parts']+1,records=state['records']+len(fresh),pending=None);state['seen'].update(fresh)

def fill(identifier,credential,gone,until):
    """Copies the job's checked chat into /chat a page at a time until `until`, each part before the manifest that
    counts it. A later run resumes from the manifest's next cursor; once complete with records still being checked,
    it reads again from the start and writes only lines the box does not have yet. A part /chat has no room for
    ends the copy for good: the manifest then says full, and this box is never filled again."""
    state=BOXES[identifier]
    if state['full']:return
    try:
        if state['pending']:write_part(identifier,state,until);put(identifier,'manifest.json',manifest(state),until)
        if state['complete'] and not state['checking']:return
        if state['complete']:state.update(complete=False,next=None,checking=0)
        while not gone() and time.monotonic()<until-WRITE_SECONDS:
            records,following,checking,complete=chat_page(credential,state['next'],until-WRITE_SECONDS)
            lines={}
            for record in records:
                line=jsonl(record);lines.setdefault(hashlib.sha256(line).digest()[:16],line)
            fresh={k:v for k,v in lines.items() if k not in state['seen']}
            if fresh:state['pending']=fresh;write_part(identifier,state,until)
            after={**state,'next':following,'complete':complete,'checking':state['checking']+checking}
            put(identifier,'manifest.json',manifest(after),until)
            state.update(next=following,complete=complete,checking=after['checking'])
            if complete:return
    except RuntimeError as error:
        if str(error)!='box_chat_full':raise
        # Full only once the manifest says so; until then a later run reads the page again and finds no room again.
        state.update(complete=False,pending=None);put(identifier,'manifest.json',manifest({**state,'full':True}),until);state['full']=True

def repo_deadline(deadline,labels):
    """The run's hard deadline in epoch seconds, from the trusted turn request, capped at the box's expiry."""
    end=expiry(labels['nocheh.box.expires'])
    return min(deadline if type(deadline) in (int,float) and math.isfinite(deadline) else end,end)

def repo_state(identifier,state=None):
    """A box's repo state, set to `state` when given; None once the box is gone."""
    with REPO_LOCK:
        entry=(BOXES.get(identifier) or {}).get('repo')
        if entry is None:return None
        if state is not None:entry['state']=state
        return entry['state']

def fill_repo(identifier,repo,hard):
    """Copies the pinned bundle into the box's /repo through box_repo, as uid 65531. Runs in its own thread beside
    the /chat fill, and may finish beside the run: its writer time ends REPO_MARGIN before the run's hard deadline."""
    fixed=[repo['name'],repo['branch'],repo['commit']];bundle=None
    def fail(reason):exec_stdin(identifier,[*REPO_WRITER,'fail',*fixed,reason],f'{REPO_UID}:{REPO_UID}',b'',time.monotonic()+REPO_GRACE)
    try:
        while True:
            seconds=min(WRITER_SECONDS,int(hard-time.time())-REPO_MARGIN)
            if seconds<REPO_FLOOR:fail('timeout');repo_state(identifier,'failed');return
            if bundle is None:
                try:
                    bundle=open(os.open(os.path.join(REPO_COPIES,repo['digest']+'.bundle'),os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC),'rb')
                    status=os.fstat(bundle.fileno())
                    kept=stat.S_ISREG(status.st_mode) and status.st_size==repo['bytes']
                except OSError:kept=False
                # Removed, restored without its file, or never mounted: the job reads that the copy is missing.
                if not kept:fail('missing');repo_state(identifier,'failed');return
            else:bundle.seek(0)
            code=exec_stdin(identifier,[*REPO_WRITER,'copy',*fixed,str(repo['bytes']),str(repo['need']),repo['digest'],str(seconds)],
                            f'{REPO_UID}:{REPO_UID}',bundle,time.monotonic()+seconds+REPO_GRACE)
            # An earlier writer still holds the lock and ends by its own writer time; a later request may retry.
            if code==5:repo_state(identifier,'pending');return
            with REPO_LOCK:
                entry=(BOXES.get(identifier) or {}).get('repo')
                if entry is None:return
                entry['tries']+=1;tries=entry['tries']
            if code==0:repo_state(identifier,'ready');return
            if code==3 and tries<REPO_TRIES:continue
            if code in (2,4,6,7):repo_state(identifier,'failed');return
            fail('bytes' if code==3 else 'timeout');repo_state(identifier,'failed');return
    except Exception:pass  # The manifest says how the copy ended.
    finally:
        if bundle:bundle.close()
        # Nothing retries a copy within this run, so one that ended without a verdict failed.
        if repo_state(identifier)=='copying':
            with contextlib.suppress(Exception):fail('timeout')
            repo_state(identifier,'failed')

def start_repo(identifier,repo,hard):
    """Starts the box's copy thread unless the copy already ran or runs; returns the thread to wait for, or None."""
    with REPO_LOCK:
        entry=(BOXES.get(identifier) or {}).get('repo')
        if entry is None:return None
        if entry['state']=='copying' and entry['thread'] and entry['thread'].is_alive():return entry['thread']
        if entry['state']!='pending':return None
        entry['state']='copying';entry['thread']=threading.Thread(target=fill_repo,args=(identifier,repo,hard),daemon=True)
        entry['thread'].start();return entry['thread']

def prepare_box(box,credential,gone,limit,until,deadline=None):
    """Reuses the job's box when this launcher filled it under the binding's guard state, else replaces it; then
    starts the copy of its GitHub copy, if any, and fills /chat. All of it ends by `until`; a longer copy goes on
    beside the run. Returns the box's container Id and name (also its socket volume's name)."""
    labels=box_labels(box);repo=box_repo(box);box_token()
    if expiry(labels['nocheh.box.expires'])<=time.time():raise ValueError('job_box_expired')
    with BOX_LOCK:
        found,_=boxes();mine=[c for c in found if c['Labels'].get('nocheh.box.job')==labels['nocheh.box.job']]
        reuse=len(mine)==1 and mine[0].get('State')=='running' and mine[0]['Id'] in BOXES and labels['nocheh.box.job'] not in ABNORMAL and \
            all(mine[0]['Labels'].get('nocheh.box.'+k)==labels['nocheh.box.'+k] for k in BOX_KEY)
        if reuse:identifier,name=mine[0]['Id'],mine[0]['Names'][0][1:]
        else:
            for c in mine:remove_box(c['Id'],c['Names'][0][1:])
            others=[c for c in found if c not in mine and c.get('State')=='running']
            if len(others)>=limit:
                # A box the sweep would remove holds no slot: its job stopped running, its guard state moved on, or it
                # expired. The live list is asked for after the listing, so a box made just before still has its job there.
                try:current=live_boxes(max(.1,min(10,until-time.monotonic())))
                except Exception:current=None
                now=time.time();stale=[c for c in others if not kept(c['Labels'],current,now)]
                for c in stale:remove_box(c['Id'],c['Names'][0][1:])
                if len(others)-len(stale)>=limit:raise ValueError('job_box_limit')
            # The image is resolved at every create, so a box never runs a tag that moved since startup.
            image=docker('GET','/images/'+box_image()+'/json')['Id']
            name='nocheh-box-'+secrets.token_hex(12);gid=int(os.environ['NOCHEH_GID']);identifier=None
            spec=box_spec(image,gid,name,labels,repo=repo is not None)
            docker('POST','/volumes/create',volume_spec(name,gid,labels))
            try:
                identifier=docker('POST','/containers/create?name='+name,spec)['Id']
                docker('POST','/containers/'+identifier+'/start')
            except Exception:
                remove_box(identifier or name,name);raise
            BOXES[identifier]={'complete':False,'next':None,'parts':0,'records':0,'checking':0,'full':False,'seen':set(),'pending':None,
                               'repo':{'state':'pending','tries':0,'thread':None} if repo else None}
            ABNORMAL.discard(labels['nocheh.box.job'])
    copying=None
    if repo:
        with contextlib.suppress(Exception):copying=start_repo(identifier,repo,repo_deadline(deadline,labels))
    try:
        if not reuse:put(identifier,'manifest.json',manifest(BOXES[identifier]),until)
        fill(identifier,credential,gone,until)
    except Exception:pass  # The manifest says how much of the copy arrived.
    # The turn starts once /chat and /repo are both done, or at `until`; /repo/manifest.json says copying until then.
    if copying and not gone():copying.join(max(0,until-time.monotonic()))
    return identifier,name

def exit_code(identifier):
    """Sets a wait for a turn's exit before the turn starts (Docker answers its headers once the wait is set), so the
    exit code is known even after Docker removed the turn. Returns a function that gives the code once the turn ended,
    or None if it is not known within 10 s."""
    client=DockerConnection();client.timeout=10
    try:
        client.request('POST','/v1.41/containers/'+identifier+'/wait?condition=next-exit');response=client.getresponse()
        if response.status!=200:raise RuntimeError('container_operation_failed')
    except Exception:
        client.close();return lambda:None
    def code():
        with contextlib.closing(response),contextlib.closing(client):
            try:return json.loads(response.read(4096)).get('StatusCode')
            except Exception:return None
    return code

def done(tail):
    """Whether a turn's output ends with its result line, and the result is done."""
    try:return json.loads(bytes(tail)).get('state')=='done'
    except Exception:return False

def running(identifier):
    try:return docker('GET','/containers/'+identifier+'/json')['State']['Running'] is True
    except Exception:return False

# Isolated containers running at once, set by the owner; each holds 2 GiB and 2 CPUs.
SLOTS=threading.BoundedSemaphore(parallel('NOCHEH_PARALLEL_RUNS',4))
ACTIVE=set()
ACTIVE_LOCK=threading.Lock()
CONTAINERS=set()
# Jobs with a turn in flight: two runs of one job never share its box.
BOX_JOBS=set()

def stop_active_turns(*_):
    """A stopping launcher cannot stream results, so its running turns must end too."""
    with ACTIVE_LOCK:identifiers=list(CONTAINERS)
    # Force removal also covers a turn created but not yet started.
    for identifier in identifiers:
        try:docker('DELETE','/containers/'+identifier+'?force=true')
        except Exception:pass
    raise SystemExit(0)

def stop(*_):
    try:stop_active_turns()
    finally:
        with contextlib.suppress(Exception):sweep(lambda:{})

def peer_closed(connection):
    try:return bool(select.select([connection],[],[],0)[0]) and not connection.recv(1,socket.MSG_PEEK)
    except OSError:return True

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path!='/health':self.send_error(404);return
        self.send_response(200);self.end_headers();self.wfile.write(b'{"ok":true,"service":"security-launcher"}')
    def do_POST(self):
        secret=os.environ['SERVICE_TOKEN']
        if self.path!='/v1/turn' or not hmac.compare_digest(self.headers.get('Authorization','').encode(),('Bearer '+secret).encode()):
            self.send_error(403);return
        if not SLOTS.acquire(blocking=False):self.send_error(503);return
        identifier=None;profile=None;reserved=False;job=None;closed=threading.Event();killed=threading.Event();started=time.monotonic()
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=2*1024*1024:raise ValueError('turn_size_limit')
            body=json.loads(self.rfile.read(length));credential=body['archive_credential']
            request=Request(security_url()+'/v1/security/binding',headers={'Authorization':'Bearer '+credential})
            with build_opener(ProxyHandler({})).open(request,timeout=120) as response:binding=json.load(response)
            profile=binding['profile'];validate_local_profile(profile)
            boxed=binding.get('box') is not None
            with ACTIVE_LOCK:
                if profile in ACTIVE:raise ValueError('profile_busy')
                if boxed:
                    if box_labels(binding['box'])['nocheh.box.job'] in BOX_JOBS:raise ValueError('job_busy')
                    job=binding['box']['job'];BOX_JOBS.add(job)
                ACTIVE.add(profile);reserved=True
            if body.get('model')!=binding['model'] or body.get('owner')!=binding['owner'] or body.get('chat_id')!=binding['scope']:raise ValueError('turn_binding_mismatch')
            from .security_transport import scoped_transport
            body.update(scoped_transport(credential,body['api_mode']))
            body['model_context_length']=binding['model_context_length']
            box=None
            if boxed:
                # Without its box the turn stops with job_box_unavailable before its agent runs.
                with contextlib.suppress(Exception):
                    box=prepare_box(binding['box'],credential,lambda:peer_closed(self.connection),self.server.box_limit,started+FILL_SECONDS,
                                    body.get('turn_deadline_epoch'))
            with BOX_LOCK if box else contextlib.nullcontext():
                # A box the sweep removed meanwhile is not mounted; Docker would recreate its volume empty.
                if box and not running(box[0]):box=None
                spec=container_spec(profile,self.server.host_profiles,self.server.image,self.server.network,int(os.environ['NOCHEH_UID']),int(os.environ['NOCHEH_GID']),
                                    os.environ.get('NOCHEH_DEV_TURN_SOURCE') or None,box[1] if box else None)
                identifier=docker('POST','/containers/create?name=nocheh-turn-'+uuid.uuid4().hex,spec)['Id']
                # Cleared only when the turn ends by itself, with exit code 0, no kill and a done result.
                if box:ABNORMAL.add(job)
            with ACTIVE_LOCK:CONTAINERS.add(identifier)
            exited=exit_code(identifier) if box else None
            self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.send_header('Cache-Control','no-store');self.end_headers()
            def watch():
                while not closed.wait(.2):
                    if peer_closed(self.connection):
                        killed.set()
                        try:docker('POST','/containers/'+identifier+'/kill')
                        except Exception:pass
                        return
            watcher=threading.Thread(target=watch,daemon=True);watcher.start()
            tail=bytearray()
            for content in attach(identifier,body):
                self.wfile.write(content);self.wfile.flush()
                if box:
                    # Only the output's last line is kept: the turn's result.
                    start=max(0,len(tail)-1);tail+=content
                    if (cut:=tail.rfind(b'\n',start,len(tail)-1))>=0:del tail[:cut+1]
            if box and not killed.is_set() and exited()==0 and done(tail):ABNORMAL.discard(job)
        except Exception:
            # Deliberately omit exception messages, Docker bodies and request material.
            if identifier is None:self.send_error(503,'isolated_turn_unavailable')
        finally:
            closed.set()
            if identifier:
                try:docker('DELETE','/containers/'+identifier+'?force=true')
                except Exception:pass
                with ACTIVE_LOCK:CONTAINERS.discard(identifier)
            if reserved:
                with ACTIVE_LOCK:ACTIVE.discard(profile);BOX_JOBS.discard(job)
            SLOTS.release();self.close_connection=True

def box_problems():
    """What stops every box, for one startup line; never the token itself."""
    problems=[] if len(os.environ.get('NOCHEH_BOX_TOKEN',''))>=32 else ['NOCHEH_BOX_TOKEN is not set (./bin/nocheh up or make dev generates it)']
    try:docker('GET','/images/'+box_image()+'/json')
    except Exception:problems.append(f'the image {box_image()} is missing (./bin/nocheh up, ./bin/nocheh build or make dev builds it)')
    return problems

def repo_problems(mounted):
    """What stops GitHub copies in boxes, for one startup line; boxes without a copy still work."""
    if any(m.get('Destination')==REPO_COPIES for m in mounted):return []
    return ['the GitHub copies folder is not mounted at '+REPO_COPIES+' (./bin/nocheh up adds it)']

def main():
    network=agent_network();limit=box_limit()
    description=docker('GET','/networks/'+network)
    if description.get('Internal') is not True:raise RuntimeError('internal_network_required')
    image=docker('GET','/images/'+os.environ.get('NOCHEH_TURN_IMAGE','nocheh-hermes:local')+'/json')['Id']
    mounted=docker('GET','/containers/'+socket.gethostname()+'/json')['Mounts']
    inventory=next((m for m in mounted if m['Destination']=='/profiles' and m['Type']=='bind' and not m['RW']),None)
    if not inventory:raise RuntimeError('readonly_profile_inventory_required')
    copies=next((m for m in mounted if m['Destination']==REPO_COPIES),None)
    if copies and not (copies['Type']=='bind' and not copies['RW']):raise RuntimeError('readonly_repo_copies_required')
    # Remove orphaned turns from a previous launcher instance. Never restart them.
    for container in docker('GET','/containers/json?all=true'):
        if container.get('Labels',{}).get('nocheh.role')=='isolated-turn' and network in container.get('NetworkSettings',{}).get('Networks',{}):docker('DELETE','/containers/'+container['Id']+'?force=true')
    # This installation's boxes from a previous instance too: their fill state is gone with it.
    sweep(lambda:{})
    if problems:=box_problems():print('security-launcher: no sealed job boxes: '+'; '.join(problems),file=sys.stderr,flush=True)
    if problems:=repo_problems(mounted):print('security-launcher: no GitHub copies in boxes: '+'; '.join(problems),file=sys.stderr,flush=True)
    server=ThreadingHTTPServer(('0.0.0.0',8787),Handler);server.image=image;server.network=network;server.host_profiles=inventory['Source']
    server.box_limit=limit
    threading.Thread(target=sweeper,daemon=True).start()
    signal.signal(signal.SIGTERM,stop)
    server.serve_forever()

if __name__=='__main__':main()
