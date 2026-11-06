"""The owner's GitHub key, and the repository copies that box jobs the owner approves may read (ADR-0209).

The owner pastes a fine-grained token once. It is kept in the installation's admin folder with the other keys
(ADR-0175), and no view returns it. A copy is made only on the owner's press or by the hourly check: a fresh fetcher
container from the box image, with its own uid, no mounts and no environment, fetches the default branch with the
key and sends back a git bundle (tools/runtime/repo_fetch.py). Nothing here runs git on repository data; this file
only calls GitHub's API, docker and the store. A bundle is kept by its sha256 in <state>/github/copies only at the
commit GitHub's API named, and the store records it; a job pins it when it is asked for.

github.json's flock guards the file and the copies folder. It is held only for short steps, such as a grant check
and a fetcher's `docker create`, never across a GitHub call or a fetcher's run. Remove and Disconnect never wait for
a copy: the store decides whether a finished copy may still be saved, by the copy_id the copy started from.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from tools.operations.connections import secret_file

# The bounds of a copy (ADR-0209 §0). Same numbers and patterns as repo_fetch.py, box_repo.py, security_launcher.py
# and background-jobs.ts; a parity test reads them.
MAX_REPOS=10
MAX_BUNDLE=64*1024**2
MAX_FILES=50000
MAX_FILE=64*1024**2
REPO_ROOM=256*1024**2
REPO_INODES=65536
REPO_RESERVE=8*1024**2
PAGE=4096
FETCH_SECONDS=150
FETCH_UID=65530
NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')
BRANCH=re.compile(r'[A-Za-z0-9._/-]{1,255}')
COMMIT=re.compile(r'[a-f0-9]{40}')
DIGEST=re.compile(r'[a-f0-9]{64}')
COPY_ID=re.compile(r'[a-f0-9]{32}')
PROJECT=re.compile(r'[a-z0-9][a-z0-9_-]{0,62}')
# Only fine-grained tokens; classic ghp_ tokens are refused.
TOKEN=re.compile(r'github_pat_[A-Za-z0-9_]{20,255}')
LOGIN=re.compile(r'[A-Za-z0-9-]{1,39}')

API_URL='https://api.github.com'
GIT_URL='https://github.com'
# The tester's fake GitHub, used only in a fixture installation and only at this exact address (src/security/broker.ts).
FIXTURE_GITHUB_URL='http://model-fixture:8317/github'
API_VERSION='2022-11-28'
JSON='application/vnd.github+json'
NETWORK='nocheh-repo-fetch'
FETCHER=re.compile(r'nocheh-repo-fetch-[a-f0-9]{24}')
BUNDLE=re.compile(r'[a-f0-9]{64}\.bundle')
COPIES='/v1/background-jobs/copies'
STORE_SECONDS=15
# A set is refused by the store past its not_after, so it never commits after this file stopped waiting for it.
NOT_AFTER_SECONDS=10
LIST_PAGES=3
# A refresh starts no copy after this, so it ends inside management's 15-minute kill.
REFRESH_SECONDS=600
OLD_FETCHER_SECONDS=600
INCOMING_SECONDS=3600


def repo_name(value):
    return type(value) is str and bool(NAME.fullmatch(value)) and value.split('/')[1] not in ('.','..') and not value.endswith('.git')


def repo_branch(value):
    # '@{' needs no check: neither character is in the class.
    return type(value) is str and bool(BRANCH.fullmatch(value)) and not re.search(r'\.\.|//|^[-/.]|[/.]$|\.lock$',value)


def need(bundle,pages,index,objects):
    """The bytes a copy needs in /repo: the bundle and the pack it becomes, or the pack and the checkout, plus the
    pack's .idx and .rev, and the reserve."""
    return bundle+max(bundle,pages+index)+4096+32*objects+REPO_RESERVE


def fingerprint(token):return hashlib.sha256(token.encode()).hexdigest()


def fixture():
    return os.environ.get('NOCHEH_INSTALLATION_FIXTURE')=='1' and os.environ.get('NOCHEH_GITHUB_URL')==FIXTURE_GITHUB_URL


def api_base():return FIXTURE_GITHUB_URL+'/api' if fixture() else API_URL


def git_base():return FIXTURE_GITHUB_URL+'/git' if fixture() else GIT_URL


class Refuse(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def request(url,body=None,headers=None):
    """One GitHub API request: tool_execution's pinned public HTTPS, or the fixture's plain http without proxies or
    redirects. Answers (content, lowercased headers); raises RuntimeError('remote_unauthorized') on 401."""
    if not fixture():
        from tools.operations.security.tool_execution import https_request
        return https_request(url,body,headers)
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}),Refuse).open(urllib.request.Request(url,headers=headers or {}),timeout=15) as response:
            content=response.read(2*1024*1024+1)
            if len(content)>2*1024*1024:raise RuntimeError('remote_response_limit')
            return content,{key.lower():value for key,value in response.getheaders()}
    except urllib.error.HTTPError as error:
        raise RuntimeError('remote_unauthorized' if error.code==401 else 'remote_response_rejected') from None


def store(path,body=None):
    from tools.operations.archive.archive import API
    return API().call(path,body,timeout=STORE_SECONDS)


def resolve():
    """github.com's IPv4 address, every one of them public; the fetcher's git connects only there."""
    from tools.operations.security.tool_execution import public_target
    try:return public_target(GIT_URL+'/',resolver=lambda host,port,type=0:socket.getaddrinfo(host,port,socket.AF_INET,type))[1]
    except Exception:raise ValueError('github_unavailable') from None


def tools(request=None,run=None,popen=None,api=None,resolve=None):
    """What a call reaches: GitHub's API, the docker command, the store and DNS. Tests pass their own."""
    module=globals()
    return SimpleNamespace(request=request or module['request'],run=run or subprocess.run,popen=popen or subprocess.Popen,
                           api=api or store,resolve=resolve or module['resolve'])


# The sign-in file.

def read(state):return secret_file.read(state,'github')


def held(state,expected):
    """The key, while github.json still holds the one whose sha256 is `expected`. Call under the flock."""
    token=(read(state).get('grant') or {}).get('token')
    if not (isinstance(token,str) and secrets.compare_digest(fingerprint(token),expected)):raise ValueError('github_not_connected')
    return token


def granted(state,expected):
    """The grant check before each GitHub call: the same key is still connected."""
    with secret_file.locked(state,'github'):return held(state,expected)


def refused(state,expected):
    """GitHub refused the key: it is dropped and the owner asked to connect again; existing copies stay usable."""
    with secret_file.locked(state,'github'):
        saved=read(state);grant=saved.get('grant') or {}
        if isinstance(grant.get('token'),str) and fingerprint(grant['token'])==expected:
            saved['grant']={key:grant.get(key) for key in ('login','connected_at','expires_at')};saved['reconnect']=True
            secret_file.write(state,'github',saved)


def github(t,token,path,rejected,accept=JSON):
    """One GitHub API call with this key. A non-2xx answer raises `rejected`, a 401 github_token_refused."""
    headers={'Authorization':'Bearer '+token,'Accept':accept,'X-GitHub-Api-Version':API_VERSION}
    try:return t.request(api_base()+path,None,headers)
    except RuntimeError as error:
        if str(error)=='remote_unauthorized':raise ValueError('github_token_refused') from None
        raise ValueError(rejected if str(error)=='remote_response_rejected' else 'github_unavailable') from None
    except Exception:
        raise ValueError('github_unavailable') from None


def keyed(state,t,expected,path,rejected,accept=JSON):
    """A GitHub call right after the grant check; a 401 drops the key."""
    token=granted(state,expected)
    try:return github(t,token,path,rejected,accept)
    except ValueError as error:
        if str(error)=='github_token_refused':refused(state,expected)
        raise


def expiry(value):
    """GitHub's token expiry header as ISO UTC, or None."""
    if not isinstance(value,str):return None
    for form in ('%Y-%m-%d %H:%M:%S %Z','%Y-%m-%d %H:%M:%S %z','%Y-%m-%dT%H:%M:%S%z'):
        try:moment=datetime.strptime(value.strip(),form)
        except ValueError:continue
        return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return None


def decoded(content,kind=dict):
    try:value=json.loads(content)
    except (TypeError,ValueError):raise ValueError('github_unavailable') from None
    if not isinstance(value,kind):raise ValueError('github_unavailable')
    return value


def repositories(get):
    """The repositories the key can read, as GitHub lists them; malformed entries are skipped."""
    listed={}
    for page in range(1,LIST_PAGES+1):
        rows=decoded(get('/user/repos?per_page=100&sort=full_name&page=%d'%page)[0],list)
        for row in rows:
            if isinstance(row,dict) and repo_name(row.get('full_name')) and repo_branch(row.get('default_branch')) \
                    and type(row.get('private')) is bool and type(row.get('size')) is int and row['size']>=0:
                listed[row['full_name'].lower()]={'name':row['full_name'],'branch':row['default_branch'],'private':row['private'],'size_kb':row['size']}
        if len(rows)<100:break
    return sorted(listed.values(),key=lambda row:row['name'].lower())


# The copies folder.

def folder(state):
    """<state>/github/copies, made one folder at a time at 0700; a link there is refused."""
    root=Path(state)/'github';copies=root/'copies'
    for path in (root,copies):
        if path.is_symlink():raise ValueError('github_connection_path_denied')
        path.mkdir(exist_ok=True,mode=0o700)
    return copies


def kept(place,digest):
    """Whether a copy's bundle is a regular file; a missing copy counts as removed."""
    try:return stat.S_ISREG(os.lstat(place/(digest+'.bundle')).st_mode)
    except OSError:return False


def checked(value):
    if not (isinstance(value,dict) and isinstance(value.get('copies'),list) and isinstance(value.get('pinned'),list)
            and type(value.get('removal')) is int and value['removal']>=0
            and all(isinstance(row,dict) and repo_name(row.get('repo')) and type(row.get('digest')) is str and DIGEST.fullmatch(row['digest'])
                    for row in value['copies'])):
        raise ValueError('github_unavailable')
    return value


def copies(t):
    """The store's copies and the digests jobs pin."""
    try:value=t.api(COPIES)
    except Exception:raise ValueError('github_unavailable') from None
    return checked(value)


def change(t,body):
    """A change of copies in the store: (answer, None), or (None, a code)."""
    try:return checked(t.api(COPIES,body)),None
    except urllib.error.HTTPError as error:
        try:code=json.loads(error.read(4096)).get('error')
        except Exception:code=None
        return None,code if code in ('github_copy_cancelled','github_repo_limit') else 'github_unavailable'
    except Exception:
        return None,'github_unavailable'


def named(t,digest):
    """Whether a copy or a job's pin names the digest; True when the store does not answer, so nothing is deleted."""
    try:known=copies(t)
    except ValueError:return True
    return digest in known['pinned'] or any(digest in (row['digest'],row.get('previous_digest')) for row in known['copies'])


# Docker: the fetcher's network, image and containers.

def docker(t,*args,timeout=30):
    try:return t.run(['docker',*args],stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout)
    except (OSError,subprocess.SubprocessError):return None


def inspected(t,name):
    result=docker(t,'network','inspect','--format','{{json .}}',name)
    if not result or result.returncode:return None
    try:value=json.loads(result.stdout)
    except ValueError:return None
    return value if isinstance(value,dict) else None


def network(t):
    """The fetcher's network: a bridge, so git reaches github.com, with traffic between fetchers off."""
    if fixture():
        name=os.environ.get('NOCHEH_GITHUB_FIXTURE_NETWORK','')
        found=inspected(t,name) if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',name) else None
        if not found or found.get('Internal') is not True:raise ValueError('github_network_conflict')
        return name
    found=inspected(t,NETWORK)
    if found is None:
        docker(t,'network','create','--driver','bridge','--label','nocheh.role=repo-fetch','--opt','com.docker.network.bridge.enable_icc=false',NETWORK)
        # Another installation may have made it meanwhile.
        found=inspected(t,NETWORK)
        if found is None:raise ValueError('github_copy_unavailable')
    if (found.get('Labels') or {}).get('nocheh.role')!='repo-fetch' or found.get('Driver')!='bridge' or found.get('Internal') is not False \
            or (found.get('Options') or {}).get('com.docker.network.bridge.enable_icc')!='false':
        raise ValueError('github_network_conflict')
    return NETWORK


def image(t):
    """The box image the launcher uses, by its sha256 Id."""
    name=os.environ.get('NOCHEH_BOX_IMAGE') or 'nocheh-box:local'
    result=docker(t,'image','inspect','--format','{{.Id}}',name) if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}',name) else None
    identity=result.stdout.strip() if result and not result.returncode else ''
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',identity):raise ValueError('github_copy_unavailable')
    return identity


def project():
    """This installation's Compose project, which scopes its fetchers as the agent network scopes its boxes."""
    name=os.environ.get('COMPOSE_PROJECT_NAME','')
    return name if PROJECT.fullmatch(name) else None


def created(value):
    try:return datetime.fromisoformat(re.sub(r'(\.\d{6})\d+','\\1',str(value)).replace('Z','+00:00')).timestamp()
    except ValueError:return 0


def fetchers(t,owner):
    """This installation's fetchers, created or running, with when each was created: both labels and the name."""
    listed=docker(t,'ps','-a','--no-trunc','--filter','label=nocheh.role=repo-fetch','--filter','label=nocheh.repo-fetch.project='+owner,
                  '--format','{{.Names}}')
    names=[name for name in (listed.stdout.split() if listed and not listed.returncode else []) if FETCHER.fullmatch(name)]
    result=docker(t,'container','inspect',*names) if names else None
    try:rows=json.loads(result.stdout) if result else []
    except ValueError:rows=[]
    found=[]
    for row in rows if isinstance(rows,list) else []:
        name=str(row.get('Name','')).lstrip('/');labels=(row.get('Config') or {}).get('Labels') or {}
        if FETCHER.fullmatch(name) and labels.get('nocheh.role')=='repo-fetch' and labels.get('nocheh.repo-fetch.project')==owner:
            found.append((name,created(row.get('Created'))))
    return found


def fetcher_command(name,owner,net,identity):
    """The fetcher: the box image as uid 65530 with no mounts, no environment and no Docker socket; DNS is cut and
    git connects only to the pinned address. The key reaches it only on stdin."""
    return ['docker','create','--pull=never','--rm','-i','--name',name,'--label','nocheh.role=repo-fetch',
            '--label','nocheh.repo-fetch.project='+owner,'--network',net,*([] if fixture() else ['--dns','127.0.0.1']),
            '--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user','%d:%d'%(FETCH_UID,FETCH_UID),
            '--pids-limit=64','--memory=1g','--memory-swap=1g','--cpus=1',
            '--tmpfs','/fetch:rw,noexec,nosuid,nodev,size=256m,uid=%d,gid=%d,mode=0700'%(FETCH_UID,FETCH_UID),
            '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m','--ulimit','fsize=83886080:83886080','--ulimit','nofile=1024:1024',
            '--ulimit','core=0:0','--log-driver=none','--entrypoint','python3',identity,'-I','/opt/box/repo_fetch.py']


# The fetcher's exit codes (repo_fetch.py), as the card's codes.
EXITS={10:'github_token_refused',11:'github_repo_not_readable',12:'github_repo_too_large',13:'github_copy_refused',15:'github_copy_cancelled'}


def read_exact(stream,size):
    data=b''
    while len(data)<size and (chunk:=stream.read(size-len(data))):data+=chunk
    return data


def fetch(t,name,body,incoming):
    """Starts the created fetcher, sends it the request and streams its bundle into `incoming` while counting and
    hashing. Returns (code or None, metadata bytes, byte count, sha256)."""
    killed=threading.Event()
    def kill():killed.set();docker(t,'rm','-f',name)
    watchdog=threading.Timer(FETCH_SECONDS,kill);watchdog.daemon=True
    try:process=t.popen(['docker','start','-ai',name],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    except OSError:
        docker(t,'rm','-f',name);return 'github_unavailable',None,0,None
    watchdog.start();meta=None;count=0;digest=hashlib.sha256();verdict=None
    try:
        try:process.stdin.write(json.dumps(body).encode()+b'\n');process.stdin.close()
        except OSError:pass
        head=read_exact(process.stdout,4)
        if len(head)==4:
            length=int.from_bytes(head,'big')
            if length>4096:verdict='github_copy_refused';kill()
            else:
                meta=read_exact(process.stdout,length)
                with os.fdopen(os.open(incoming,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600),'wb') as file:
                    while chunk:=process.stdout.read(1<<20):
                        count+=len(chunk)
                        if count>MAX_BUNDLE:verdict='github_repo_too_large';kill();break
                        digest.update(chunk);file.write(chunk)
        # A removed fetcher's stream ends; what is left of it is read and dropped, so docker start can exit.
        while process.stdout.read(1<<20):pass
        code=process.wait()
    finally:
        watchdog.cancel()
        try:process.stdout.close()
        except OSError:pass
    if verdict:return verdict,None,0,None
    # A watchdog kill, a Disconnect's removal or a failed start.
    if killed.is_set() or code not in (0,*EXITS):return 'github_unavailable',None,0,None
    return EXITS.get(code),meta,count,digest.hexdigest()


def header(path,branch,commit):
    """Whether a bundle starts with exactly a v2 header, one ref for this branch at this commit and no prerequisite."""
    expected=b'# v2 git bundle\n'+commit.encode()+b' refs/heads/'+branch.encode()+b'\n\n'
    with open(path,'rb',opener=lambda file,flags:os.open(file,flags|os.O_NOFOLLOW)) as file:return file.read(len(expected))==expected


def metadata(raw):
    try:value=json.loads(raw)
    except (TypeError,ValueError):return None
    keys=('commit','objects','files','dirs','largest','pages','index')
    if not (isinstance(value,dict) and set(value)==set(keys) and type(value['commit']) is str and COMMIT.fullmatch(value['commit'])
            and all(type(value[key]) is int and value[key]>=0 for key in keys[1:])):return None
    return value


# What the card and the timer call.

def status(state,**hooks):
    """The card's view: who is connected, what the key lists and what is copied. Never the key."""
    t=tools(**hooks);saved=read(state);grant=saved.get('grant') or {}
    try:
        place=folder(state)
        view=[{**{key:value for key,value in row.items() if key!='copy_id'},'missing':not kept(place,row['digest'])} for row in copies(t)['copies']]
    except Exception:view=None
    return {'connected':bool(grant.get('token')),'login':grant.get('login'),'connected_at':grant.get('connected_at'),
            'expires_at':grant.get('expires_at'),'reconnect':bool(saved.get('reconnect')),'listed':saved.get('listed') or [],
            'listed_at':saved.get('listed_at'),'copies':view}


def flags(state):
    """What problem notices need: the file only, with no network, no lock and no key."""
    saved=read(state);grant=saved.get('grant') or {}
    return {'connected':bool(grant.get('token')),'reconnect':bool(saved.get('reconnect')),'expires_at':grant.get('expires_at')}


def save_token(state,value,**hooks):
    """Checks a fine-grained token once with GitHub, lists what it can read and saves it."""
    t=tools(**hooks);token=value.strip() if isinstance(value,str) else ''
    if not TOKEN.fullmatch(token):raise ValueError('invalid_github_token')
    content,received=github(t,token,'/user','github_unavailable')
    login=decoded(content).get('login')
    if not (type(login) is str and LOGIN.fullmatch(login)):raise ValueError('github_unavailable')
    listed=repositories(lambda path:github(t,token,path,'github_unavailable'))
    with secret_file.locked(state,'github'):
        saved=read(state);now=int(time.time())
        saved.update(grant={'token':token,'login':login,'connected_at':now,'expires_at':expiry(received.get('github-authentication-token-expiration'))},
                     reconnect=False,listed=listed,listed_at=now)
        secret_file.write(state,'github',saved)
    return status(state,**hooks)


def list_repos(state,**hooks):
    t=tools(**hooks)
    with secret_file.locked(state,'github'):token=(read(state).get('grant') or {}).get('token')
    if not isinstance(token,str):raise ValueError('github_not_connected')
    expected=fingerprint(token);del token
    listed=repositories(lambda path:keyed(state,t,expected,path,'github_unavailable'))
    with secret_file.locked(state,'github'):
        held(state,expected);saved=read(state);saved.update(listed=listed,listed_at=int(time.time()));secret_file.write(state,'github',saved)
    return status(state,**hooks)


def copy(state,name,expected_id=None,**hooks):
    """Copies a repository's default branch at the commit GitHub's API names (ADR-0209 §1). A refresh passes the
    copy_id it saw as `expected_id`, so it only ever updates that copy and never makes a removed one new again."""
    t=tools(**hooks)
    # 1. Connected, and a name GitHub could have.
    with secret_file.locked(state,'github'):token=(read(state).get('grant') or {}).get('token')
    if not isinstance(token,str):raise ValueError('github_not_connected')
    if not repo_name(name):raise ValueError('invalid_github_repo')
    expected=fingerprint(token);del token
    def get(path,accept=JSON):return keyed(state,t,expected,path,'github_repo_not_readable',accept)
    place=folder(state)
    # 3, before GitHub is asked, so a Remove during the copy finds it pinned: the copy this replaces. Step 2 requires
    # GitHub's name to equal this one in any case. A copy whose bundle is missing counts as removed, so this one gets a
    # new copy_id.
    known=copies(t);row=next((r for r in known['copies'] if r['repo'].lower()==name.lower()),None)
    if expected_id is not None and not (row and row.get('copy_id')==expected_id and kept(place,row['digest'])):
        raise ValueError('github_copy_cancelled')
    if row and not kept(place,row['digest']):
        known,code=change(t,{'remove':row['repo']})
        if code:raise ValueError('github_unavailable')
        row=None
    previous=row['copy_id'] if row else None
    if previous is not None and not (type(previous) is str and COPY_ID.fullmatch(previous)):raise ValueError('github_unavailable')
    if previous is None and sum(r['repo'].lower()!=name.lower() for r in known['copies'])>=MAX_REPOS:raise ValueError('github_repo_limit')
    # The last Remove the store numbered, this copy's own included: the store refuses a new copy after a later one.
    removal=known['removal']
    # 2. The repository as GitHub names it, before anything is downloaded.
    repository=decoded(get('/repos/'+name)[0])
    full,branch,size=repository.get('full_name'),repository.get('default_branch'),repository.get('size')
    if not (repo_name(full) and repo_branch(branch) and type(size) is int and size>=0):raise ValueError('github_copy_refused')
    if full.lower()!=name.lower():raise ValueError('github_repo_not_readable')
    if size*1024>2*MAX_BUNDLE:raise ValueError('github_repo_too_large')
    # 4. The API commit: the row's commit, and the card's, is GitHub's own answer.
    commit=get('/repos/%s/commits/%s'%(full,branch),'application/vnd.github.sha')[0].strip().decode('ascii','replace')
    if not COMMIT.fullmatch(commit):raise ValueError('github_copy_refused')
    if row and row.get('branch')==branch and row.get('commit')==commit and kept(place,row['digest']):return {'state':'current'}
    # 5-6. The pinned address, the network, the image and this installation's project; leftovers of an earlier copy go.
    address=None if fixture() else t.resolve()
    net=network(t);identity=image(t);owner=project()
    if owner is None:raise ValueError('github_copy_unavailable')
    now=time.time()
    for old,when in fetchers(t,owner):
        if now-when>OLD_FETCHER_SECONDS:docker(t,'rm','-f',old)
    # 7. The fetcher is created right after a grant check, under the flock, so a Disconnect either removes it or
    # comes first and no fetcher exists.
    container='nocheh-repo-fetch-'+secrets.token_hex(12)
    with secret_file.locked(state,'github'):
        token=held(state,expected)
        made=docker(t,*fetcher_command(container,owner,net,identity)[1:],timeout=60)
        if not made or made.returncode:raise ValueError('github_copy_unavailable')
    body={'repo':full,'branch':branch,'commit':commit,'authorization':base64.b64encode(('x-access-token:'+token).encode()).decode(),
          'ip':address,'limits':{'bundle':MAX_BUNDLE,'files':MAX_FILES,'file':MAX_FILE,'room':REPO_ROOM,'inodes':REPO_INODES}}
    del token
    if fixture():body['base']=git_base()
    incoming=place/('.incoming-'+secrets.token_hex(8))
    try:
        # 8-9. The bundle, then the fetcher's verdict, then the header and the bounds, checked here without git.
        code,raw,count,digest=fetch(t,container,body,incoming);body=None
        if code=='github_token_refused':refused(state,expected)
        if code:raise ValueError(code)
        meta=metadata(raw)
        # A Disconnect's cleanup may have deleted the incoming file meanwhile.
        try:whole=meta is not None and count>0 and header(incoming,branch,meta['commit'])
        except OSError:raise ValueError('github_copy_cancelled') from None
        if not whole:raise ValueError('github_copy_refused')
        # The branch moved after step 4, or the fetcher sent another commit.
        if meta['commit']!=commit:raise ValueError('github_copy_cancelled')
        room=need(count,meta['pages'],meta['index'],meta['objects'])
        if room>REPO_ROOM or meta['files']>MAX_FILES or meta['largest']>MAX_FILE or meta['files']+meta['dirs']+1024>REPO_INODES:
            raise ValueError('github_repo_too_large')
        # 10. Saved only while the same key is connected, and recorded only if the store still allows it.
        with secret_file.locked(state,'github'):
            held(state,expected)
            final=place/(digest+'.bundle');os.replace(incoming,final);incoming=None
            answer,code=change(t,{'set':{'repo':full,'branch':branch,'commit':commit,'digest':digest,'bytes':count,'need':room,
                                         'files':meta['files'],'copy_id':previous,'removal':removal,'not_after':int(time.time())+NOT_AFTER_SECONDS}})
            if code:
                if not named(t,digest):final.unlink(missing_ok=True)
                raise ValueError(code)
    finally:
        if incoming is not None:incoming.unlink(missing_ok=True)
        # A fetcher that ended early is gone already (--rm); this removes one that never started.
        docker(t,'rm','-f',container)
    # 11.
    try:cleanup(state,**hooks)
    except ValueError:pass
    saved=next((r for r in answer['copies'] if r['repo'].lower()==full.lower()),{})
    return {'state':'copied','repo':full,'branch':branch,'commit':commit,'copied_at':saved.get('copied_at'),'bytes':count,'files':meta['files']}


def remove(state,name,**hooks):
    """Removes a copy at once, connected or not; the store withdraws the jobs that have not started on it."""
    t=tools(**hooks)
    if not repo_name(name):raise ValueError('invalid_github_repo')
    _,code=change(t,{'remove':name})
    if code:raise ValueError('github_unavailable')
    cleanup(state,**hooks)
    return status(state,**hooks)


def disconnect(state,**hooks):
    """Forgets the key first, removes this installation's fetchers, then every copy. Never waits for a copy."""
    t=tools(**hooks)
    with secret_file.locked(state,'github'):
        saved=read(state)
        for key in ('grant','listed','listed_at','reconnect'):saved.pop(key,None)
        secret_file.write(state,'github',saved)
    owner=project()
    for name,_ in fetchers(t,owner) if owner else []:docker(t,'rm','-f',name)
    _,code=change(t,{'clear':True})
    if code:raise ValueError('github_unavailable')
    # After the key left the file, no copy can save what it is receiving.
    cleanup(state,every=True,**hooks)
    return status(state,**hooks)


def cleanup(state,every=False,**hooks):
    """Deletes bundles no copy or pin names, and old incoming files (every one when `every`). Holds the flock across
    the store's answer and the deletes, so a copy saving its bundle is never cut short."""
    t=tools(**hooks);place=folder(state);removed=0
    with secret_file.locked(state,'github'):
        known=copies(t);now=time.time()
        keep={row['digest'] for row in known['copies']}|{row['previous_digest'] for row in known['copies'] if isinstance(row.get('previous_digest'),str)}
        keep|={digest for digest in known['pinned'] if isinstance(digest,str)}
        with os.scandir(place) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False):continue
                stale=BUNDLE.fullmatch(entry.name) and entry.name[:64] not in keep or entry.name.startswith('.incoming-') \
                    and (every or now-entry.stat(follow_symlinks=False).st_mtime>INCOMING_SECONDS)
                if stale:
                    try:os.unlink(entry.path);removed+=1
                    except FileNotFoundError:pass
    return {'removed':removed}


def refresh(state,**hooks):
    """The hourly check: copies each kept copy again when its branch moved, the oldest first. A job never changes its
    copy: it reads the digest it pinned."""
    t=tools(**hooks);started=time.monotonic()
    cleanup(state,**hooks)
    saved=read(state)
    if not (saved.get('grant') or {}).get('token') or saved.get('reconnect'):return status(state,**hooks)
    place=folder(state)
    for name in [row['repo'] for row in sorted(copies(t)['copies'],key=lambda row:str(row.get('copied_at') or ''))]:
        if time.monotonic()-started>REFRESH_SECONDS:break
        try:row=next((r for r in copies(t)['copies'] if r['repo'].lower()==name.lower()),None)
        except ValueError:break
        # Gone, or missing: a missing copy waits for the owner's Copy again, which makes it a new copy.
        if not row or not kept(place,row['digest']):continue
        # Only the copy it saw: one removed meanwhile, or removed and copied afresh, is not this refresh's to change.
        try:copy(state,row['repo'],expected_id=row['copy_id'],**hooks)
        except ValueError as error:
            if str(error) in ('github_token_refused','github_not_connected'):break
    return status(state,**hooks)
