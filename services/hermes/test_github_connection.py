"""Nocheh's GitHub App and its repository copies (ADR-0209, ADR-0210): github.py against fakes of GitHub's API, docker
and the store."""
import base64
import copy as deep
import hashlib
import io
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from tools.operations.connections import github, secret_file

REPO='example-org/widgets'
LOGIN='octo-example'
PROJECT='example'
IMAGE='sha256:'+'ab'*32
ADDRESS='1.2.3.4'
RETURN='http://localhost:8783/connect/github'
APP_ID=4242
INSTALLATION=77
LIMITS={'bundle':64*1024**2,'files':50000,'file':64*1024**2,'room':256*1024**2,'inodes':65536}


def pem_of(key):
    """A private key as GitHub hands one over: PKCS#1 PEM."""
    return key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode()


# One made-up app key for every test; making one takes a moment.
KEY=rsa.generate_private_key(public_exponent=65537,key_size=2048)
PEM=pem_of(KEY)
# The part of the key that must never leave github.py's process.
SECRET=PEM.splitlines()[5]


def unpadded(text):return base64.urlsafe_b64decode(text+'='*(-len(text)%4))


def installation_token(n):
    # Built at run time from parts, so no literal in the repository looks like a token.
    return 'gh'+'s_'+'%036d'%n


def app_json(**changes):
    """GitHub's answer to the manifest conversion, client and webhook secrets included, as GitHub sends them."""
    return {'id':APP_ID,'slug':'nocheh-a1b2c3','name':'Nocheh-a1b2c3','owner':{'login':LOGIN,'type':'User'},'html_url':'https://github.com/apps/nocheh-a1b2c3',
            'client_id':'Iv1.example','client_secret':'CLIENTSECRET'+'x'*20,'webhook_secret':'WEBHOOKSECRET'+'x'*20,'pem':PEM,**changes}


def stamp():return datetime.now(timezone.utc).isoformat()


def conflict(code):
    return urllib.error.HTTPError(github.COPIES,409,'Conflict',{},io.BytesIO(json.dumps({'error':code}).encode()))


def bundle_header(commit,branch='main'):return b'# v2 git bundle\n'+commit.encode()+b' refs/heads/'+branch.encode()+b'\n\n'


class GitHub:
    """GitHub's API for one app: the manifest conversion, the app's own calls under its signed token, the installation
    keys it makes, an installation's repositories, and one repository and its branch's commit."""
    def __init__(self):
        self.commit='c'*40;self.full=REPO;self.branch='main';self.size=12;self.repos=[];self.calls=[];self.hooks={}
        self.revoked=False;self.conversions={};self.issued={};self.public=KEY.public_key()
        self.installations=[{'id':INSTALLATION,'account':{'login':'example-org','type':'Organization'}}]
        # Which installation reaches which repository, by lowercased name.
        self.reach={REPO.lower():INSTALLATION}
    def __call__(self,url,body=None,headers=None):
        assert url.startswith(github.api_base()+'/'),url
        path=url[len(github.api_base()):];self.calls.append((path,dict(headers),deep.deepcopy(body)))
        if path in self.hooks:self.hooks.pop(path)()
        authorization=headers.get('Authorization','')
        if path.startswith('/app-manifests/'):
            assert path.endswith('/conversions') and body=={} and not authorization,(path,body)
            app=self.conversions.pop(path.split('/')[2],None)
            if app is None:raise RuntimeError('remote_response_rejected')
            return json.dumps(app).encode(),{}
        if path.startswith('/app/') or path.startswith('/repos/') and path.endswith('/installation'):
            self.signed(authorization);assert headers['Accept']=='application/vnd.github+json'
            return self.as_app(path,body)
        assert body is None,path
        issued=self.issued.get(authorization.removeprefix('Bearer '))
        if not authorization.startswith('Bearer ') or issued is None:raise RuntimeError('remote_unauthorized')
        if path.startswith('/installation/repositories?per_page=100&page='):
            page=int(path.rsplit('=',1)[1]);return json.dumps({'total_count':len(self.repos),'repositories':self.repos[(page-1)*100:page*100]}).encode(),{}
        name=path[len('/repos/'):].split('/commits/')[0]
        if issued['repositories'] is not None and name.split('/')[-1].lower() not in issued['repositories']:raise RuntimeError('remote_response_rejected')
        if path.lower()=='/repos/'+REPO.lower():
            return json.dumps({'full_name':self.full,'default_branch':self.branch,'size':self.size,'private':True}).encode(),{}
        if path=='/repos/%s/commits/%s'%(self.full,self.branch):
            assert headers['Accept']=='application/vnd.github.sha' and issued['permissions'].get('contents')=='read'
            return self.commit.encode(),{}
        raise RuntimeError('remote_response_rejected')
    def signed(self,authorization):
        """GitHub's check of the app's own token: RS256 by the app's key, for at most ten minutes."""
        if self.revoked or not authorization.startswith('Bearer '):raise RuntimeError('remote_unauthorized')
        head,claims,signature=authorization[7:].split('.')
        try:self.public.verify(unpadded(signature),(head+'.'+claims).encode(),padding.PKCS1v15(),hashes.SHA256())
        except InvalidSignature:raise RuntimeError('remote_unauthorized') from None
        claims=json.loads(unpadded(claims))
        assert json.loads(unpadded(head))=={'alg':'RS256','typ':'JWT'} and claims['iss']==str(APP_ID) and claims['exp']-claims['iat']==600,claims
        assert abs(claims['iat']+60-time.time())<5,claims
    def as_app(self,path,body):
        if path=='/app/installations?per_page=100':return json.dumps(self.installations).encode(),{}
        if path.startswith('/repos/'):
            found=self.reach.get(path[len('/repos/'):-len('/installation')].lower())
            if found is None:raise RuntimeError('remote_response_rejected')
            return json.dumps({'id':found,'account':{'login':'example-org'}}).encode(),{}
        installation=int(path.split('/')[3]);assert path=='/app/installations/%d/access_tokens'%installation,path
        if installation not in [row.get('id') for row in self.installations if isinstance(row,dict)]:raise RuntimeError('remote_response_rejected')
        wanted=body.get('repositories')
        if wanted is not None and any(self.reach.get('example-org/'+name.lower())!=installation for name in wanted):raise RuntimeError('remote_response_rejected')
        token=installation_token(len(self.issued)+1)
        self.issued[token]={'installation':installation,'repositories':None if wanted is None else [name.lower() for name in wanted],'permissions':body['permissions']}
        return json.dumps({'token':token,'expires_at':'2026-12-01T10:00:00Z','permissions':body['permissions']}).encode(),{}
    def keys(self):return [body for path,_,body in self.calls if path.endswith('/access_tokens')]


class Store:
    """The app's copies route with the store's rules (ADR-0209 §3); `fail` makes a kind unreachable, `lose` loses its answer.
    Each Remove is numbered, also one that finds no row, and a new copy that read an earlier number is refused."""
    def __init__(self):self.rows=[];self.pinned=[];self.calls=[];self.fail=set();self.lose=set();self.hooks={};self.removal=0;self.removals={}
    def __call__(self,path,body=None):
        assert path==github.COPIES
        kind='get' if body is None else next(iter(body))
        self.calls.append((kind,deep.deepcopy(body),time.time()))
        if kind in self.hooks:self.hooks[kind]()
        if kind in self.fail:raise urllib.error.URLError('store down')
        if kind=='set':self.set(body['set'])
        elif kind=='remove':
            self.rows=[row for row in self.rows if row['repo'].lower()!=body['remove'].lower()]
            self.removal+=1;self.removals[body['remove'].lower()]=self.removal
        elif kind=='clear':self.rows=[]
        if kind in self.lose:raise urllib.error.URLError('answer lost')
        return {'copies':deep.deepcopy(self.rows),'pinned':list(self.pinned),'removal':self.removal}
    def set(self,value):
        row=next((row for row in self.rows if row['repo'].lower()==value['repo'].lower()),None)
        if time.time()>value['not_after']:raise conflict('github_copy_cancelled')
        fields={key:value[key] for key in ('repo','branch','commit','digest','bytes','need','files')}
        if value['copy_id'] is None:
            if row or self.removals.get(value['repo'].lower(),0)>value['removal']:raise conflict('github_copy_cancelled')
            if len(self.rows)>=github.MAX_REPOS:raise conflict('github_repo_limit')
            self.rows.append({'copy_id':secrets.token_hex(16),**fields,'previous_digest':None,'copied_at':stamp()})
        else:
            if not row or row['copy_id']!=value['copy_id']:raise conflict('github_copy_cancelled')
            if row['digest']!=fields['digest']:row['previous_digest']=row['digest']
            row.update(fields,copied_at=stamp())
    def sets(self):return [body['set'] for kind,body,_ in self.calls if kind=='set']


class Killed(Exception):pass


class Stdin:
    def __init__(self):self.data=b'';self.done=threading.Event()
    def write(self,data):self.data+=data;return len(data)
    def close(self):self.done.set()


class Fetcher:
    """A started fetcher: it reads the request on stdin, then runs its script and exits with the script's code. A
    removed one stops at its next write or pause and exits 137; a container that is gone exits 1 at once."""
    def __init__(self,script):
        read,self.out=os.pipe();self.stdout=open(read,'rb');self.stdin=Stdin();self.request=None;self.code=None
        self.killed=threading.Event();self.wake=threading.Event();self.waiting=threading.Event()
        self.thread=threading.Thread(target=self.main,args=(script,),daemon=True);self.thread.start()
    def main(self,script):
        try:
            if script is None:self.code=1;return
            self.stdin.done.wait(10);self.request=json.loads(self.stdin.data);self.code=script(self)
        except Killed:self.code=137
        finally:os.close(self.out)
    def write(self,data):
        while data:
            if self.killed.is_set():raise Killed
            data=data[os.write(self.out,data):]
    def pause(self):
        self.waiting.set();self.wake.wait(20)
        if self.killed.is_set():raise Killed
    def kill(self):self.killed.set();self.wake.set()
    def wait(self):self.thread.join(20);return self.code


class Docker:
    """The docker command as github.py uses it: the network, the image, containers by name and label, and `start -ai`.
    `immortal` makes `rm -f` forget a running fetcher without stopping it, as a race with its end would."""
    def __init__(self):
        self.networks={};self.containers={};self.calls=[];self.started=[];self.processes=[];self.script=None
        self.immortal=False;self.before_start=None;self.no_network=False
    def run(self,argv,**kwargs):
        self.calls.append(list(argv))
        assert argv[0]=='docker' and kwargs['stdin']==subprocess.DEVNULL and kwargs['capture_output'],argv
        args=argv[1:]
        def answer(code=0,out=''):return subprocess.CompletedProcess(argv,code,out,'')
        def value(flag):return args[args.index(flag)+1]
        if args[:2]==['network','inspect']:
            found=self.networks.get(args[-1]);return answer(0,json.dumps(found)) if found else answer(1)
        if args[:2]==['network','create']:
            if not self.no_network:
                self.networks[args[-1]]={'Name':args[-1],'Driver':value('--driver'),'Internal':False,'Labels':dict([value('--label').split('=',1)]),
                                         'Options':dict([value('--opt').split('=',1)])}
            return answer()
        if args[:2]==['image','inspect']:return answer(0,IMAGE+'\n')
        if args[:2]==['ps','-a']:
            filters=[args[i+1].removeprefix('label=').split('=',1) for i,arg in enumerate(args) if arg=='--filter']
            return answer(0,''.join(name+'\n' for name,row in self.containers.items() if all(row['labels'].get(k)==v for k,v in filters)))
        if args[:2]==['container','inspect']:
            return answer(0,json.dumps([{'Name':'/'+name,'Created':self.containers[name]['created'],'Config':{'Labels':self.containers[name]['labels']}}
                                        for name in args[2:] if name in self.containers]))
        if args[:2]==['rm','-f']:
            row=self.containers.pop(args[2],None)
            if row and row['process'] and not self.immortal:row['process'].kill()
            return answer(0 if row else 1)
        if args[0]=='create':
            labels=dict(args[i+1].split('=',1) for i,arg in enumerate(args) if arg=='--label')
            self.containers[value('--name')]={'labels':labels,'created':stamp(),'process':None};return answer()
        raise AssertionError(argv)
    def popen(self,argv,**kwargs):
        self.calls.append(list(argv))
        assert argv[:3]==['docker','start','-ai'] and len(argv)==4 and kwargs=={'stdin':subprocess.PIPE,'stdout':subprocess.PIPE,'stderr':subprocess.DEVNULL}
        if self.before_start:hook,self.before_start=self.before_start,None;hook()
        row=self.containers.get(argv[3]);process=Fetcher(self.script if row else None)
        if row:row['process']=process
        self.started.append(argv[3]);self.processes.append(process)
        return process
    def created(self):return [argv for argv in self.calls if argv[1:2]==['create']]


class GitHubTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);self.state=Path(folder.name)
        environment=patch.dict(os.environ,{'COMPOSE_PROJECT_NAME':PROJECT,'NOCHEH_BOX_IMAGE':'nocheh-box:local'});environment.start();self.addCleanup(environment.stop)
        for key in ('NOCHEH_INSTALLATION_FIXTURE','NOCHEH_GITHUB_URL','NOCHEH_GITHUB_FIXTURE_NETWORK'):os.environ.pop(key,None)
        self.remote=GitHub();self.store=Store();self.docker=Docker();self.docker.script=self.served()
        self.resolved=0
        def resolve():self.resolved+=1;return ADDRESS
        self.hooks={'request':self.remote,'run':self.docker.run,'popen':self.docker.popen,'api':self.store,'resolve':resolve}

    # Helpers.

    def meta(self,commit,**changes):
        return {'commit':commit,'objects':12,'files':5,'dirs':4,'largest':64,'pages':5*4096,'index':4096+5*140,**changes}

    def served(self,commit=None,meta=None,header=None,body=b'PACK'+b'\1'*64,code=0,frame=None,pause=False,during=None):
        """A fetcher's script: the framing, the metadata, then a bundle at `commit` (the request's by default)."""
        def script(process):
            tip=commit or process.request['commit'];data=json.dumps(meta(tip) if callable(meta) else meta or self.meta(tip)).encode()
            process.write((len(data) if frame is None else frame).to_bytes(4,'big')+data)
            process.write(bundle_header(tip) if header is None else header(tip))
            if pause:process.pause()
            if during:during()
            process.write(body)
            return code
        return script

    def silent(self,code):
        def script(process):return code
        return script

    def connect(self,**changes):
        """Connect GitHub as the dashboard does it: start, GitHub creates the app, finish with its code."""
        started=github.start(self.state,RETURN)
        nonce=urllib.parse.parse_qs(urllib.parse.urlsplit(started['action']).query)['state'][0]
        code='code'+secrets.token_hex(4);self.remote.conversions[code]=app_json(**changes)
        return github.finish(self.state,code,nonce,**self.hooks)

    def shown(self,*values):
        """No key of the app, and no secret GitHub sent with it, is in any of these."""
        for value in values:
            text=json.dumps(value)
            for secret in (SECRET,'CLIENTSECRET','WEBHOOKSECRET'):self.assertNotIn(secret,text)

    def copied(self,name=REPO):return github.copy(self.state,name,**self.hooks)

    def files(self):return sorted(path.name for path in (self.state/'github/copies').iterdir())

    def saved(self):return json.loads(secret_file.path(self.state,'github').read_text())

    def failing(self,code,call=None):
        with self.assertRaises(ValueError) as caught:(call or self.copied)()
        self.assertEqual(str(caught.exception),code)

    # The app.

    def test_connect_github_asks_github_for_a_private_read_only_app_from_this_dashboard(self):
        for bad in ('http://example.com/connect/github','https://example.com/connect/github?next=1','https://example.com/other',
                    'https://user:pass@example.com/connect/github','https://example.com/connect/github#x','http://localhost:x/connect/github',
                    'javascript:alert(1)','',None,7):
            with self.subTest(redirect=bad):self.failing('invalid_github_redirect',lambda:github.start(self.state,bad))
        for bad in ('-bad','a'*40,'a b','example/org',7):
            with self.subTest(organization=bad):self.failing('invalid_github_organization',lambda:github.start(self.state,RETURN,bad))
        self.assertFalse(secret_file.path(self.state,'github').exists(),'nothing is kept for a refused start')
        started=github.start(self.state,RETURN)
        nonce=self.saved()['pending']['state']
        self.assertEqual(started['action'],'https://github.com/settings/apps/new?state='+nonce)
        manifest=json.loads(started['manifest'])
        self.assertRegex(manifest.pop('name'),r'^Nocheh-[a-f0-9]{6}$')
        self.assertTrue(manifest.pop('description'))
        self.assertEqual(manifest,{'url':'http://localhost:8783','redirect_url':RETURN,'setup_url':RETURN,'setup_on_update':True,'public':False,
                                   'default_permissions':{'contents':'read','metadata':'read'},'default_events':[]})
        self.assertEqual(github.start(self.state,'https://nocheh.example/connect/github','  example-org ')['action'],
                         'https://github.com/organizations/example-org/settings/apps/new?state='+self.saved()['pending']['state'])
        self.assertNotEqual(self.saved()['pending']['state'],nonce,'a new start replaces the one before')

    def test_finish_trades_the_code_once_and_keeps_only_the_app_and_its_key_at_0600(self):
        view=self.connect()
        self.assertEqual({key:view[key] for key in ('connected','app','reconnect','listed','copies','install_url')},
                         {'connected':True,'reconnect':False,'listed':[],'copies':[],'install_url':'https://github.com/apps/nocheh-a1b2c3/installations/new',
                          'app':{'name':'Nocheh-a1b2c3','account':LOGIN,'install_url':'https://github.com/apps/nocheh-a1b2c3/installations/new',
                                 'settings_url':'https://github.com/settings/apps/nocheh-a1b2c3'}})
        self.assertIs(type(view['connected_at']),int)
        conversion,=self.remote.calls
        self.assertEqual((conversion[0],conversion[1].get('Authorization')),(conversion[0],None))
        self.assertRegex(conversion[0],r'^/app-manifests/code[a-f0-9]{8}/conversions$')
        saved=self.saved()
        self.assertEqual(saved['app'],{'id':APP_ID,'slug':'nocheh-a1b2c3','name':'Nocheh-a1b2c3','account':LOGIN,'account_type':'User','pem':PEM,
                                       'connected_at':view['connected_at']})
        self.assertNotIn('pending',saved)
        self.assertEqual(stat.S_IMODE(secret_file.path(self.state,'github').stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE(secret_file.path(self.state,'github').parent.stat().st_mode),0o700)
        self.shown(view,github.status(self.state,**self.hooks),github.flags(self.state))
        self.assertEqual(github.flags(self.state),{'connected':True,'reconnect':False})
        # An organization's app is deleted in the organization's settings.
        self.connect(owner={'login':'example-org','type':'Organization'})
        self.assertEqual(github.status(self.state,**self.hooks)['app']['settings_url'],'https://github.com/organizations/example-org/settings/apps/nocheh-a1b2c3')

    def test_a_code_is_taken_once_only_for_its_own_start_and_a_bad_app_is_not_kept(self):
        started=github.start(self.state,RETURN);nonce=self.saved()['pending']['state']
        for code,state in (('a/b',nonce),('',nonce),(None,nonce),('x'*201,nonce),('code',None),('code','')):
            with self.subTest(code=code,state=state):self.failing('invalid_github_sign_in',lambda:github.finish(self.state,code,state,**self.hooks))
        self.failing('github_sign_in_expired',lambda:github.finish(self.state,'code','other',**self.hooks))
        self.remote.conversions['code']=app_json()
        github.finish(self.state,'code',nonce,**self.hooks)
        self.remote.conversions['code']=app_json()
        self.failing('github_sign_in_expired',lambda:github.finish(self.state,'code',nonce,**self.hooks))
        self.assertEqual(len(self.remote.calls),1,'a used start sends nothing')
        # A start older than PENDING_SECONDS has expired.
        github.start(self.state,RETURN);nonce=self.saved()['pending']['state']
        with patch.object(github.time,'time',return_value=time.time()+github.PENDING_SECONDS+1):
            self.failing('github_sign_in_expired',lambda:github.finish(self.state,'code',nonce,**self.hooks))
        # GitHub refuses the code, or answers with an app Nocheh does not accept: nothing is kept, and the start is spent.
        small=pem_of(rsa.generate_private_key(public_exponent=65537,key_size=1024))
        curve=ec.generate_private_key(ec.SECP256R1()).private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
        for label,answer in (('refused',None),('no key',app_json(pem=None)),('a bad slug',app_json(slug='../x')),('no owner',app_json(owner=None)),
                             ('a bad id',app_json(id='7')),('not a key',app_json(pem='-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----')),
                             ('a small key',app_json(pem=small)),('not RSA',app_json(pem=curve)),('a long name',app_json(name='x'*101))):
            with self.subTest(label):
                github.disconnect(self.state,**self.hooks);github.start(self.state,RETURN);nonce=self.saved()['pending']['state'];self.remote.conversions={}
                if answer is not None:self.remote.conversions['code']=answer
                self.failing('github_app_not_created',lambda:github.finish(self.state,'code',nonce,**self.hooks))
                self.assertEqual(self.saved(),{})

    def test_the_app_token_is_rs256_from_a_minute_ago_for_nine_minutes(self):
        token=github.app_token({'id':APP_ID,'pem':PEM},now=1_800_000_000)
        head,claims,signature=token.split('.')
        KEY.public_key().verify(unpadded(signature),(head+'.'+claims).encode(),padding.PKCS1v15(),hashes.SHA256())
        self.assertEqual((json.loads(unpadded(head)),json.loads(unpadded(claims))),
                         ({'alg':'RS256','typ':'JWT'},{'iat':1_800_000_000-60,'exp':1_800_000_000+540,'iss':str(APP_ID)}))
        self.assertNotIn('=',token)

    def test_without_the_crypto_library_github_asks_for_a_rebuild(self):
        # Before GitHub makes an app whose key Nocheh could not use.
        with patch.dict(sys.modules,{'cryptography.hazmat.primitives':None}):
            self.failing('github_rebuild_needed',lambda:github.start(self.state,RETURN))
        self.assertFalse(secret_file.path(self.state,'github').exists())
        github.start(self.state,RETURN);nonce=self.saved()['pending']['state'];self.remote.conversions['code']=app_json()
        with patch.dict(sys.modules,{'cryptography.hazmat.primitives':None}):
            self.failing('github_rebuild_needed',lambda:github.finish(self.state,'code',nonce,**self.hooks))
        self.assertEqual(self.saved(),{})

    def test_disconnect_or_a_new_connect_while_github_hands_over_the_app_keeps_nothing(self):
        for label,meanwhile in (('disconnect',lambda:github.disconnect(self.state,**self.hooks)),('a new connect',lambda:github.start(self.state,RETURN))):
            with self.subTest(label):
                github.disconnect(self.state,**self.hooks)
                started=github.start(self.state,RETURN);nonce=self.saved()['pending']['state']
                self.remote.conversions['code']=app_json();self.remote.hooks['/app-manifests/code/conversions']=meanwhile
                self.failing('github_sign_in_expired',lambda:github.finish(self.state,'code',nonce,**self.hooks))
                saved=self.saved()
                self.assertNotIn('app',saved);self.assertEqual(github.flags(self.state),{'connected':False,'reconnect':False})
                if label=='a new connect':self.assertNotEqual(saved['pending'].get('state'),nonce,'the newer sign-in is kept')

    def test_a_refused_app_asks_to_connect_again_and_the_hourly_check_tries_it_again(self):
        self.connect();self.copied();before=self.saved()['app'];self.remote.revoked=True;self.remote.commit='d'*40
        self.failing('github_app_refused',lambda:github.list_repos(self.state,**self.hooks))
        saved=self.saved()
        self.assertEqual(saved['app'],before,'the key is kept: a wrong clock also makes GitHub refuse it')
        self.assertTrue(saved['reconnect'])
        self.assertEqual(github.flags(self.state),{'connected':False,'reconnect':True})
        view=github.status(self.state,**self.hooks)
        self.assertEqual((view['connected'],view['reconnect'],view['app']['name']),(False,True,'Nocheh-a1b2c3'))
        self.shown(view)
        self.failing('github_not_connected',lambda:github.list_repos(self.state,**self.hooks))
        self.failing('github_not_connected')
        # The hourly check tries the app once, and copies nothing while GitHub still refuses it.
        calls=len(self.remote.calls);github.refresh(self.state,**self.hooks)
        self.assertEqual([path for path,_,_ in self.remote.calls[calls:]],['/app/installations?per_page=100'])
        self.assertEqual((self.saved()['reconnect'],len(self.docker.started)),(True,1))
        # Once GitHub takes it again, it is connected again and the check goes on.
        self.remote.revoked=False;github.refresh(self.state,**self.hooks)
        self.assertEqual((self.saved()['reconnect'],github.flags(self.state),self.store.rows[0]['commit']),(False,{'connected':True,'reconnect':False},'d'*40))
        # Connect again replaces a refused app.
        self.remote.revoked=True
        self.failing('github_app_refused',lambda:github.list_repos(self.state,**self.hooks))
        self.remote.revoked=False
        self.assertEqual((self.connect()['reconnect'],self.saved()['reconnect']),(False,False))

    def test_a_linked_sign_in_file_or_copies_folder_is_refused(self):
        outside=self.state/'outside.json';outside.write_text(json.dumps({'app':{'id':APP_ID,'pem':PEM}}))
        file=secret_file.path(self.state,'github');file.parent.mkdir(parents=True,mode=0o700);file.symlink_to(outside)
        for call in (lambda:github.status(self.state,**self.hooks),lambda:github.flags(self.state),self.copied,lambda:github.start(self.state,RETURN)):
            self.failing('github_connection_path_denied',call)
        file.unlink();(self.state/'elsewhere').mkdir();(self.state/'github').symlink_to(self.state/'elsewhere')
        self.failing('github_connection_path_denied',lambda:github.folder(self.state))
        self.assertIsNone(github.status(self.state,**self.hooks)['copies'])

    def test_the_list_reads_every_installation_with_list_only_keys_and_skips_malformed_rows(self):
        good=[{'full_name':'example-org/r%03d'%n,'default_branch':'main','private':n%2==0,'size':n} for n in range(300)]
        bad=[{'full_name':'example-org/..','default_branch':'main','private':True,'size':1},{'full_name':'example-org/x.git','default_branch':'main','private':True,'size':1},
             {'full_name':'example-org/a','default_branch':'-x','private':True,'size':1},{'full_name':'example-org/b','default_branch':'main','private':'yes','size':1},
             {'full_name':'example-org/c','default_branch':'main','private':True,'size':-1},{'full_name':'example-org/d','private':True,'size':1},
             {'full_name':'example-org/e','default_branch':'main','private':True,'size':True},'not a row',
             {'full_name':'Example-Org/R000','default_branch':'main','private':True,'size':0}]
        self.remote.repos=bad+good[:91]+good[91:]+[{'full_name':'example-org/zz','default_branch':'main','private':True,'size':1}]
        self.remote.installations+=[{'id':78,'account':{'login':'octo-example','type':'User'},'suspended_at':'2026-11-01T00:00:00Z'},'not a row',{'id':'79'}]
        self.connect();calls=len(self.remote.calls)
        listed=github.list_repos(self.state,**self.hooks)['listed']
        self.assertEqual([path for path,_,_ in self.remote.calls[calls:]],
                         ['/app/installations?per_page=100','/app/installations/77/access_tokens']+['/installation/repositories?per_page=100&page=%d'%n for n in (1,2,3)])
        self.assertEqual(self.remote.keys(),[{'permissions':{'metadata':'read'}}],'a key that can only list, for the one usable installation')
        names=[row['name'] for row in listed]
        self.assertEqual(names,sorted(names,key=str.lower))
        self.assertFalse({'example-org/..','example-org/x.git','example-org/a','example-org/b','example-org/c','example-org/d','example-org/e','example-org/zz'}&set(names))
        self.assertEqual(len(names),291,'one row per name, whatever its case')
        self.assertEqual(self.saved()['listed'],listed);self.assertIs(type(self.saved()['listed_at']),int)
        self.shown(listed,self.remote.calls[1:])

    # A copy.

    def test_a_copy_creates_the_fixed_fetcher_sends_a_one_repository_key_only_on_stdin_and_keeps_the_bundle(self):
        self.connect();answer=self.copied()
        # GitHub makes a key for the installation that reads this repository's code and nothing else.
        self.assertEqual(self.remote.keys(),[{'repositories':['widgets'],'permissions':{'contents':'read','metadata':'read'}}])
        token,=self.remote.issued
        created=self.docker.created();self.assertEqual(len(created),1);name=created[0][created[0].index('--name')+1]
        self.assertRegex(name,r'nocheh-repo-fetch-[a-f0-9]{24}')
        self.assertEqual(created[0],['docker','create','--pull=never','--rm','-i','--name',name,'--label','nocheh.role=repo-fetch',
            '--label','nocheh.repo-fetch.project=example','--network','nocheh-repo-fetch','--dns','127.0.0.1','--read-only','--cap-drop=ALL',
            '--security-opt=no-new-privileges','--user','65530:65530','--pids-limit=64','--memory=1g','--memory-swap=1g','--cpus=1',
            '--tmpfs','/fetch:rw,noexec,nosuid,nodev,size=256m,uid=65530,gid=65530,mode=0700','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m',
            '--ulimit','fsize=83886080:83886080','--ulimit','nofile=1024:1024','--ulimit','core=0:0','--log-driver=none',
            '--entrypoint','python3',IMAGE,'-I','/opt/box/repo_fetch.py'])
        self.assertFalse({'-v','--volume','--mount','-e','--env','--env-file','--privileged'}&set(created[0]))
        self.assertEqual(self.docker.calls[self.docker.calls.index(created[0])+1],['docker','start','-ai',name])
        self.assertIn(['docker','network','create','--driver','bridge','--label','nocheh.role=repo-fetch','--opt',
                       'com.docker.network.bridge.enable_icc=false','nocheh-repo-fetch'],self.docker.calls)
        self.assertEqual(self.docker.calls[-1][:3],['docker','rm','-f'],'a fetcher that never ended is removed')
        authorization=base64.b64encode(('x-access-token:'+token).encode()).decode()
        for argv in self.docker.calls:self.assertFalse(any(token in part or authorization in part or SECRET in part for part in argv),argv)
        # The one-repository key reaches the fetcher only on stdin, with the API commit and the §0 limits; the app's own
        # key never does.
        self.assertEqual(json.loads(self.docker.processes[0].stdin.data),
                         {'repo':REPO,'branch':'main','commit':'c'*40,'authorization':authorization,'ip':ADDRESS,'limits':LIMITS})
        self.assertEqual(self.docker.processes[0].stdin.data.count(b'\n'),1)
        self.shown(self.docker.processes[0].stdin.data.decode())
        # The bundle is kept by its sha256 at 0600, and the store records it without the key.
        data=bundle_header('c'*40)+b'PACK'+b'\1'*64;digest=hashlib.sha256(data).hexdigest()
        self.assertEqual(self.files(),[digest+'.bundle'])
        self.assertEqual(stat.S_IMODE((self.state/'github/copies'/(digest+'.bundle')).stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE((self.state/'github/copies').stat().st_mode),0o700)
        sent,=self.store.sets();meta=self.meta('c'*40)
        self.assertEqual({key:value for key,value in sent.items() if key!='not_after'},
                         {'repo':REPO,'branch':'main','commit':'c'*40,'digest':digest,'bytes':len(data),'files':5,'copy_id':None,
                          'removal':0,'need':github.need(len(data),meta['pages'],meta['index'],meta['objects'])})
        self.assertNotIn(token,json.dumps(self.store.calls));self.shown(self.store.calls,answer)
        self.assertEqual({key:answer[key] for key in ('state','repo','branch','commit','bytes','files')},
                         {'state':'copied','repo':REPO,'branch':'main','commit':'c'*40,'bytes':len(data),'files':5})
        self.assertEqual(answer['copied_at'],self.store.rows[0]['copied_at'])
        self.assertEqual(self.resolved,1)
        # The same commit again is current and fetches nothing.
        self.assertEqual(self.copied(),{'state':'current'})
        self.assertEqual((len(self.docker.created()),len(self.docker.started)),(1,1))
        # A moved branch: Copy again keeps the copy_id, and the previous bundle stays for the jobs that pinned it.
        copy_id=self.store.rows[0]['copy_id'];self.remote.commit='d'*40;self.copied()
        self.assertEqual(self.store.sets()[-1]['copy_id'],copy_id)
        new=hashlib.sha256(bundle_header('d'*40)+b'PACK'+b'\1'*64).hexdigest()
        self.assertEqual((self.store.rows[0]['digest'],self.store.rows[0]['previous_digest']),(new,digest))
        self.assertEqual(self.files(),sorted([digest+'.bundle',new+'.bundle']))
        view=github.status(self.state,**self.hooks)['copies']
        self.assertEqual([(row['repo'],row['missing'],'copy_id' in row) for row in view],[(REPO,False,False)])

    def test_an_invalid_project_stops_the_copy_and_only_this_installations_old_fetchers_go(self):
        self.connect();os.environ['COMPOSE_PROJECT_NAME']='Not A Project'
        self.failing('github_copy_unavailable');self.assertEqual(self.docker.created(),[])
        os.environ['COMPOSE_PROJECT_NAME']=PROJECT
        old=datetime.fromtimestamp(time.time()-1200,timezone.utc).isoformat()
        fetch={'nocheh.role':'repo-fetch','nocheh.repo-fetch.project':PROJECT}
        self.docker.containers={'nocheh-repo-fetch-'+'0'*24:{'labels':fetch,'created':old,'process':None},
                                'nocheh-repo-fetch-'+'1'*24:{'labels':{**fetch,'nocheh.repo-fetch.project':'other'},'created':old,'process':None},
                                'nocheh-repo-fetch-'+'2'*24:{'labels':fetch,'created':stamp(),'process':None},
                                'nocheh-box-'+'3'*24:{'labels':fetch,'created':old,'process':None},
                                'nocheh-repo-fetch-'+'4'*24:{'labels':{'nocheh.repo-fetch.project':PROJECT},'created':old,'process':None}}
        self.copied()
        self.assertEqual(sorted(self.docker.containers),['nocheh-box-'+'3'*24,'nocheh-repo-fetch-'+'1'*24,'nocheh-repo-fetch-'+'2'*24,'nocheh-repo-fetch-'+'4'*24])
        listing,=[argv for argv in self.docker.calls if argv[1:2]==['ps']]
        self.assertEqual(listing,['docker','ps','-a','--no-trunc','--filter','label=nocheh.role=repo-fetch','--filter',
                                  'label=nocheh.repo-fetch.project=example','--format','{{.Names}}'])

    def test_the_network_must_be_nochehs_and_the_fixture_needs_its_flag_and_an_internal_network(self):
        self.connect()
        good={'Name':github.NETWORK,'Driver':'bridge','Internal':False,'Labels':{'nocheh.role':'repo-fetch'},'Options':{'com.docker.network.bridge.enable_icc':'false'}}
        for change in ({'Labels':{}},{'Driver':'overlay'},{'Internal':True},{'Options':{'com.docker.network.bridge.enable_icc':'true'}}):
            with self.subTest(change=change):
                self.docker.networks={github.NETWORK:{**good,**change}};self.failing('github_network_conflict')
        self.docker.networks={};self.docker.no_network=True;self.failing('github_copy_unavailable')
        self.assertEqual(self.docker.created(),[])
        # The fixture: the flag and the exact address, and an internal network named by the installation.
        for environment in ({'NOCHEH_GITHUB_URL':github.FIXTURE_GITHUB_URL},{'NOCHEH_INSTALLATION_FIXTURE':'1'},
                            {'NOCHEH_INSTALLATION_FIXTURE':'1','NOCHEH_GITHUB_URL':'http://model-fixture:8317/other'}):
            with self.subTest(environment=environment),patch.dict(os.environ,environment):
                self.assertEqual((github.fixture(),github.api_base(),github.git_base()),(False,github.API_URL,github.GIT_URL))
        os.environ.update(NOCHEH_INSTALLATION_FIXTURE='1',NOCHEH_GITHUB_URL=github.FIXTURE_GITHUB_URL)
        self.assertEqual((github.api_base(),github.git_base()),(github.FIXTURE_GITHUB_URL+'/api',github.FIXTURE_GITHUB_URL+'/git'))
        self.connect();self.failing('github_network_conflict')
        os.environ['NOCHEH_GITHUB_FIXTURE_NETWORK']='example_fixture'
        self.docker.networks={'example_fixture':{'Name':'example_fixture','Driver':'bridge','Internal':False}};self.failing('github_network_conflict')
        self.docker.networks['example_fixture']['Internal']=True;resolved=self.resolved;self.copied()
        created,=self.docker.created()
        self.assertEqual(created[created.index('--network')+1],'example_fixture');self.assertNotIn('--dns',created)
        request=json.loads(self.docker.processes[-1].stdin.data)
        self.assertEqual((request['ip'],request['base']),(None,github.FIXTURE_GITHUB_URL+'/git'))
        self.assertEqual(self.resolved,resolved,'the fixture resolves nothing')

    def test_a_bad_answer_from_the_fetcher_keeps_nothing(self):
        tip='c'*40
        cases=(('framing over the cap',self.served(frame=4097),'github_copy_refused'),
               ('two refs',self.served(header=lambda c:b'# v2 git bundle\n'+c.encode()+b' refs/heads/main\n'+c.encode()+b' refs/heads/other\n\n'),'github_copy_refused'),
               ('a prerequisite',self.served(header=lambda c:b'# v2 git bundle\n-'+b'd'*40+b'\n'+c.encode()+b' refs/heads/main\n\n'),'github_copy_refused'),
               ('a header at another commit',self.served(header=lambda c:bundle_header('e'*40)),'github_copy_refused'),
               ('another branch',self.served(header=lambda c:bundle_header(c,'other')),'github_copy_refused'),
               ('a v3 bundle',self.served(header=lambda c:b'# v3 git bundle\n'+c.encode()+b' refs/heads/main\n\n'),'github_copy_refused'),
               ('no bundle',self.served(header=lambda c:b'',body=b''),'github_copy_refused'),
               ('no metadata',self.served(meta={'commit':tip}),'github_copy_refused'),
               ('a boolean count',self.served(meta=lambda c:self.meta(c,files=True)),'github_copy_refused'),
               ('an extra key',self.served(meta=lambda c:{**self.meta(c),'extra':1}),'github_copy_refused'),
               ('need over REPO_ROOM',self.served(meta=lambda c:self.meta(c,pages=github.REPO_ROOM)),'github_repo_too_large'),
               ('inodes over REPO_INODES',self.served(meta=lambda c:self.meta(c,files=40000,dirs=github.REPO_INODES-40000-1023)),'github_repo_too_large'),
               ('a file over MAX_FILE',self.served(meta=lambda c:self.meta(c,largest=github.MAX_FILE+1)),'github_repo_too_large'),
               ('files over MAX_FILES',self.served(meta=lambda c:self.meta(c,files=github.MAX_FILES+1)),'github_repo_too_large'),
               ('the branch moved',self.served(commit='e'*40),'github_copy_cancelled'),
               ('exit 11',self.silent(11),'github_repo_not_readable'),('exit 12',self.served(code=12),'github_repo_too_large'),
               ('exit 13',self.silent(13),'github_copy_refused'),('exit 15',self.silent(15),'github_copy_cancelled'),
               ('exit 14',self.silent(14),'github_unavailable'),('exit 1',self.silent(1),'github_unavailable'),
               ('exit 0 without output',self.silent(0),'github_copy_refused'),('exit 10',self.silent(10),'github_repo_not_readable'))
        for label,script,code in cases:
            with self.subTest(label):
                self.connect();self.docker.script=script;self.failing(code)
                self.assertEqual((self.files(),self.store.rows,self.store.sets()),([],[],[]))
                self.assertFalse(self.docker.containers,'no fetcher is left')
        # Git refusing the one-repository key says nothing of the app's own key, which stays.
        self.assertEqual((self.saved()['reconnect'],self.saved()['app']['pem']),(False,PEM))

    def test_the_watchdog_and_the_bundle_cap_stop_a_fetcher(self):
        self.connect();self.docker.script=self.served(pause=True)
        with patch.object(github,'FETCH_SECONDS',0.3):
            started=time.monotonic();self.failing('github_unavailable');self.assertLess(time.monotonic()-started,10)
        self.assertTrue(self.docker.processes[-1].killed.is_set())
        self.assertEqual((self.files(),self.store.rows),([],[]))
        self.remote.size=0;self.docker.script=self.served(body=b'P'*5000)
        with patch.object(github,'MAX_BUNDLE',1000):self.failing('github_repo_too_large')
        self.assertEqual(json.loads(self.docker.processes[-1].stdin.data)['limits']['bundle'],1000)
        self.assertTrue(self.docker.processes[-1].killed.is_set())
        self.assertEqual((self.files(),self.store.rows),([],[]))
        # What GitHub says of the size is checked before anything is fetched.
        self.remote.size=2*github.MAX_BUNDLE//1024+1;started=len(self.docker.started);self.failing('github_repo_too_large')
        self.assertEqual(len(self.docker.started),started)

    def test_the_name_github_and_the_store_must_agree(self):
        self.connect()
        for name in ('example-org/..','example-org/widgets.git','-example/widgets','example-org',None):
            with self.subTest(name=name):self.failing('invalid_github_repo',lambda:self.copied(name))
        self.remote.full='example-org/other';self.failing('github_repo_not_readable',lambda:self.copied(REPO));self.remote.full=REPO
        self.failing('github_repo_not_readable',lambda:self.copied('example-org/missing'))
        self.remote.branch='-x';self.failing('github_copy_refused');self.remote.branch='main'
        self.remote.commit='not a commit';self.failing('github_copy_refused');self.remote.commit='c'*40
        self.store.rows=[{'copy_id':secrets.token_hex(16),'repo':'example-org/r%d'%n,'branch':'main','commit':'c'*40,'digest':'%064x'%n,
                          'bytes':1,'need':1,'files':1,'previous_digest':None,'copied_at':stamp()} for n in range(github.MAX_REPOS)]
        self.failing('github_repo_limit');self.assertEqual(self.docker.created(),[])
        self.store.rows=[];self.store.fail={'get'};self.failing('github_unavailable')

    # Disconnect and Remove never wait for a copy.

    def check_disconnect_during_a_refresh(self,immortal):
        self.connect();self.copied();self.remote.commit='d'*40
        self.docker.script=self.served(pause=True);self.docker.immortal=immortal
        held=[];self.store.hooks['clear']=lambda:held.append(self.saved().get('app'))
        ended=[];refresh=threading.Thread(target=lambda:ended.append(github.refresh(self.state,**self.hooks)),daemon=True);refresh.start()
        deadline=time.monotonic()+10
        while len(self.docker.processes)<2 and time.monotonic()<deadline:time.sleep(0.01)
        process=self.docker.processes[-1];self.assertTrue(process.waiting.wait(10))
        started=time.monotonic();view=github.disconnect(self.state,**self.hooks);self.assertLess(time.monotonic()-started,5)
        self.assertEqual(held,[None],'the app left the file before the store call')
        self.assertIn(['docker','rm','-f',self.docker.started[-1]],self.docker.calls)
        self.assertEqual((view['connected'],view['copies']),(False,[]))
        process.wake.set();refresh.join(20);self.assertFalse(refresh.is_alive());self.assertTrue(ended)
        self.assertEqual(process.code,0 if immortal else 137)
        clear=[n for n,(kind,_,_) in enumerate(self.store.calls) if kind=='clear'][0]
        self.assertEqual([kind for kind,_,_ in self.store.calls[clear:] if kind=='set'],[],'the late copy adds no row')
        self.assertEqual((self.store.rows,self.files(),self.saved()),([],[],{}))

    def test_disconnect_during_a_running_refresh_removes_the_fetcher_and_its_copy_keeps_nothing(self):
        self.check_disconnect_during_a_refresh(False)

    def test_disconnect_during_a_running_refresh_whose_fetcher_finishes_anyway_keeps_nothing(self):
        self.check_disconnect_during_a_refresh(True)

    def test_disconnect_between_the_api_commit_and_the_start(self):
        self.connect()
        self.remote.hooks['/repos/%s/commits/main'%REPO]=lambda:github.disconnect(self.state,**self.hooks)
        self.failing('github_not_connected')
        self.assertEqual((self.docker.created(),self.docker.started),([],[]),'no fetcher is created or started')
        # Between the create and the start: the Disconnect removes the created fetcher, and the start fails.
        self.connect();self.docker.before_start=lambda:github.disconnect(self.state,**self.hooks)
        self.failing('github_unavailable')
        self.assertEqual(len(self.docker.created()),1);self.assertEqual(self.docker.processes[-1].code,1)
        self.assertEqual((self.docker.containers,self.files(),self.store.rows,self.store.sets()),({},[],[],[]))

    def test_remove_during_a_copy_again_cancels_it(self):
        self.connect();self.copied();old=self.store.rows[0]['copy_id'];self.remote.commit='d'*40
        self.docker.script=self.served(during=lambda:github.remove(self.state,REPO,**self.hooks))
        self.failing('github_copy_cancelled')
        self.assertEqual(self.store.sets()[-1]['copy_id'],old)
        self.assertEqual((self.files(),self.store.rows),([],[]),'the new bundle is unlinked and the old one cleaned up')
        self.docker.script=self.served();self.copied()
        self.assertNotEqual(self.store.rows[0]['copy_id'],old,'a later Copy is a new copy')

    def test_a_remove_while_a_refresh_asks_github_keeps_the_copy_removed(self):
        self.connect();self.copied();old=self.store.rows[0]['copy_id'];self.remote.commit='d'*40
        # The owner's Remove lands during the refresh's first GitHub call.
        self.remote.hooks['/repos/'+REPO]=lambda:github.remove(self.state,REPO,**self.hooks)
        github.refresh(self.state,**self.hooks)
        self.assertNotIn(None,[body['copy_id'] for body in self.store.sets()[1:]],'the refresh sends only the copy_id it saw')
        self.assertEqual((self.store.rows,self.files()),([],[]))

    def test_a_refresh_changes_only_the_copy_it_saw(self):
        self.connect();self.copied();old=self.store.rows[0]['copy_id'];self.remote.commit='d'*40
        calls,sets=len(self.remote.calls),len(self.store.sets())
        self.failing('github_copy_cancelled',lambda:github.copy(self.state,REPO,expected_id='0'*32,**self.hooks))
        github.remove(self.state,REPO,**self.hooks)
        self.failing('github_copy_cancelled',lambda:github.copy(self.state,REPO,expected_id=old,**self.hooks))
        self.assertEqual((self.remote.calls[calls:],self.store.sets()[sets:],self.docker.created()[1:]),([],[],[]),'nothing is asked or saved')

    def test_a_remove_during_a_copy_again_of_a_missing_copy_keeps_it_removed(self):
        self.connect();self.copied()
        for path in (self.state/'github/copies').iterdir():path.unlink()
        # Copy again removes the missing copy first; the owner's Remove, still offered on the card, comes after it.
        self.docker.script=self.served(during=lambda:github.remove(self.state,REPO,**self.hooks))
        self.failing('github_copy_cancelled')
        (body,)=self.store.sets()[1:]
        self.assertEqual((body['copy_id'],body['removal'],self.store.removal),(None,1,2),'the set names its own Remove, not the owner\'s')
        self.assertEqual((self.store.rows,self.files()),([],[]))

    def test_the_set_carries_not_after_and_a_failed_set_keeps_only_what_the_store_may_name(self):
        self.connect();self.copied()
        (_,body,received),=[call for call in self.store.calls if call[0]=='set']
        self.assertIn(int(received)+10-body['set']['not_after'],(0,1))
        self.store.rows=[]
        for path in (self.state/'github/copies').iterdir():path.unlink()
        # The store refuses a set past its not_after.
        with patch.object(github,'NOT_AFTER_SECONDS',-1):self.failing('github_copy_cancelled')
        self.assertEqual((self.files(),self.store.rows),([],[]))
        # The set fails and GET copies answers without the digest: the bundle goes.
        self.store.fail={'set'};self.failing('github_unavailable');self.assertEqual(self.files(),[])
        # The set fails and GET copies does not answer: the bundle stays for the next cleanup.
        self.store.hooks['set']=lambda:self.store.fail.add('get');self.failing('github_unavailable')
        self.assertEqual(len(self.files()),1)
        # The set commits and its answer is lost: the store names the digest, so the bundle stays.
        for path in (self.state/'github/copies').iterdir():path.unlink()
        self.store.fail=set();self.store.hooks={};self.store.lose={'set'};self.failing('github_unavailable')
        self.assertEqual(self.files(),[self.store.rows[0]['digest']+'.bundle'])

    def test_with_the_store_down_nothing_is_deleted(self):
        self.connect();self.copied()
        old=self.state/'github/copies/.incoming-0000000000000000';old.write_bytes(b'x');os.utime(old,(time.time()-7200,)*2)
        files=self.files();self.store.fail={'get','set','remove','clear'}
        for call in (lambda:github.remove(self.state,REPO,**self.hooks),lambda:github.cleanup(self.state,**self.hooks),
                     lambda:github.disconnect(self.state,**self.hooks)):
            self.failing('github_unavailable',call);self.assertEqual(self.files(),files)
        self.assertNotIn('app',self.saved(),'Disconnect forgets the app first')
        self.assertIsNone(github.status(self.state,**self.hooks)['copies'])

    def test_cleanup_keeps_current_previous_and_pinned_bundles(self):
        place=github.folder(self.state);digests=['%064x'%n for n in range(1,5)]
        for digest in digests:(place/(digest+'.bundle')).write_bytes(b'x')
        outside=self.state/'outside.bundle';outside.write_bytes(b'kept');(place/('%064x.bundle'%9)).symlink_to(outside)
        old=place/'.incoming-old';old.write_bytes(b'x');os.utime(old,(time.time()-7200,)*2);(place/'.incoming-young').write_bytes(b'x')
        (place/'notes.txt').write_bytes(b'x')
        self.store.rows=[{'copy_id':'a'*32,'repo':REPO,'branch':'main','commit':'c'*40,'digest':digests[0],'previous_digest':digests[1],
                          'bytes':1,'need':1,'files':1,'copied_at':stamp()}]
        self.store.pinned=[digests[2]]
        self.assertEqual(github.cleanup(self.state,**self.hooks),{'removed':2})
        self.assertEqual(self.files(),sorted(['.incoming-young','notes.txt',*(d+'.bundle' for d in digests[:3]),'%064x.bundle'%9]))
        self.assertEqual(outside.read_bytes(),b'kept','a link is left alone')

    def test_disconnect_empties_the_file_the_copies_and_the_folder_and_remove_keeps_a_young_incoming_file(self):
        self.connect();self.copied();young=self.state/'github/copies/.incoming-1111111111111111';young.write_bytes(b'x')
        github.remove(self.state,REPO,**self.hooks)
        self.assertEqual((self.files(),self.store.rows),([young.name],[]))
        self.copied();self.assertEqual(len(self.files()),2)
        view=github.disconnect(self.state,**self.hooks)
        self.assertEqual((self.saved(),self.store.rows,self.files()),({},[],[]))
        self.assertEqual({key:view[key] for key in ('connected','app','listed','copies')},{'connected':False,'app':None,'listed':[],'copies':[]})
        self.failing('github_not_connected')

    def test_a_restored_copy_whose_bundle_is_missing_is_skipped_and_copied_again_as_a_new_copy(self):
        self.connect();self.copied();old=self.store.rows[0]['copy_id']
        for path in (self.state/'github/copies').iterdir():path.unlink()
        self.remote.commit='d'*40;calls=len(self.remote.calls)
        view=github.refresh(self.state,**self.hooks)
        self.assertEqual([path for path,_ in self.remote.calls[calls:]],[],'the hourly check skips it')
        self.assertEqual([(row['repo'],row['missing']) for row in view['copies']],[(REPO,True)])
        self.assertEqual(len(self.docker.created()),1)
        calls=len(self.store.calls);self.copied()
        self.assertEqual([kind for kind,_,_ in self.store.calls[calls:]][:3],['get','remove','set'])
        self.assertEqual((self.store.sets()[-1]['copy_id'],self.store.sets()[-1]['removal']),(None,self.store.removal))
        self.assertNotEqual(self.store.rows[0]['copy_id'],old)

    def test_refresh_copies_a_moved_branch_and_stops_at_a_refused_app(self):
        self.connect();self.copied();self.remote.commit='d'*40
        github.refresh(self.state,**self.hooks)
        self.assertEqual((self.store.rows[0]['commit'],len(self.docker.started)),('d'*40,2))
        github.refresh(self.state,**self.hooks);self.assertEqual(len(self.docker.started),2,'a current copy is not fetched again')
        self.remote.commit='e'*40;self.remote.revoked=True;github.refresh(self.state,**self.hooks)
        self.assertTrue(self.saved()['reconnect']);self.assertEqual(self.store.rows[0]['commit'],'d'*40)

    def test_a_repository_the_app_cannot_read_is_refused_before_anything_is_fetched(self):
        self.connect()
        # No installation reaches it.
        self.remote.reach={};self.failing('github_repo_not_readable')
        # GitHub will not make a key for it.
        self.remote.reach={REPO.lower():INSTALLATION+1};self.failing('github_repo_not_readable')
        self.assertEqual((self.docker.created(),self.remote.issued),([],{}))
        self.assertEqual((self.saved()['reconnect'],self.saved()['app']['pem']),(False,PEM),'the app stays connected')


if __name__=='__main__':unittest.main()
