"""The GitHub fetcher against a local fake: the made-up repository over dumb HTTP behind Basic auth (ADR-0209)."""
import base64
import io
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote

from tools.runtime import repo_fetch
from . import repo_fixture as fixture


def made_token():
    # Built at run time from parts, so no literal in the repository looks like a token.
    return 'github_'+'pat_'+'FIXTURE'+'x'*24


class Server(ThreadingHTTPServer):
    """A git host that serves bare repositories as static files, only to the key, and logs each request."""
    def __init__(self,root,token):
        self.root=Path(root).resolve();self.expected='Basic '+base64.b64encode(('x-access-token:'+token).encode()).decode();self.seen=[];outer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def answer(self,status,data=b'',headers=()):
                self.send_response(status)
                for key,value in headers:self.send_header(key,value)
                self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def do_GET(self):
                outer.seen.append((self.path,self.headers.get('Authorization')))
                if self.headers.get('Authorization')!=outer.expected:return self.answer(401,headers=[('WWW-Authenticate','Basic realm="git"')])
                if self.path.startswith('/git/example-org/moved.git/'):return self.answer(301,headers=[('Location','http://127.0.0.1:9/elsewhere')])
                path=(outer.root/unquote(self.path.split('?')[0]).removeprefix('/git/')).resolve()
                if not path.is_relative_to(outer.root) or not path.is_file():return self.answer(404)
                self.answer(200,path.read_bytes())
        super().__init__(('127.0.0.1',0),Handler);threading.Thread(target=self.serve_forever,daemon=True).start()
    def base(self):return 'http://127.0.0.1:%d/git'%self.server_address[1]
    def close(self):self.shutdown();self.server_close()


class FetchTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);self.folder=Path(folder.name);self.token=made_token();self.runs=0

    def host(self,variant=None):
        source=self.folder/('source-%s'%(variant or 'plain'))
        work,commit=fixture.made(source,variant);served=source/'served';fixture.served(work,served)
        server=Server(served,self.token);self.addCleanup(server.close)
        return work,commit,server

    def request(self,server,commit,token=None,**changes):
        limits={**repo_fetch.LIMITS,**changes.pop('limits',{})}
        return {'repo':fixture.NAME,'branch':'main','commit':commit,'limits':limits,'ip':None,'base':server.base(),
                'authorization':base64.b64encode(('x-access-token:'+(token or self.token)).encode()).decode(),**changes}

    def fetch(self,request,calls=None):
        """Runs the fetcher in a fresh root; returns its exit code, its stdout and the root. Nothing may reach stderr."""
        self.runs+=1;root=self.folder/('fetch-%d'%self.runs);root.mkdir(mode=0o700)
        stdin=self.folder/('request-%d.json'%self.runs);stdin.write_bytes(json.dumps(request).encode()+b'\n')
        out=io.BytesIO();saved=os.dup(2)
        real=subprocess.run
        def run(command,**kwargs):
            if calls is not None:calls.append((command,kwargs))
            return real(command,**kwargs)
        with open(stdin,'rb') as source,tempfile.TemporaryFile() as errors,patch.object(repo_fetch.subprocess,'run',run):
            os.dup2(errors.fileno(),2)
            try:code=repo_fetch.main(source.fileno(),out,root=str(root))
            finally:os.dup2(saved,2);os.close(saved)
            errors.seek(0);self.assertEqual(errors.read(),b'','the fetcher prints nothing')
        return code,out.getvalue(),root

    def test_the_tip_its_measures_and_a_bundle_without_the_key(self):
        work,commit,server=self.host();calls=[]
        code,output,root=self.fetch(self.request(server,commit),calls)
        self.assertEqual(code,0)
        length=int.from_bytes(output[:4],'big');meta=json.loads(output[4:4+length]);bundle=output[4+length:]
        # The measures, counted here from the work repository itself.
        listing=[line.split(b'\t',1) for line in fixture.git(work,'ls-tree','-r','-l','--full-tree',commit).splitlines()]
        sizes=[int(meta_.split()[3]) for meta_,_ in listing if meta_.split()[1]==b'blob']
        expected={'commit':commit,'objects':len(fixture.git(work,'rev-list','--objects','refs/heads/main').splitlines()),
                  'files':fixture.FILES,'dirs':fixture.DIRS,'largest':max(sizes),'pages':sum(-(-s//4096)*4096 for s in sizes if s),
                  'index':4096+sum(128+2*len(path) for _,path in listing)}
        self.assertEqual(meta,expected)
        self.assertEqual(len(listing),fixture.FILES+1,'the gitlink is an index entry but not a file')
        self.assertTrue(bundle.startswith(b'# v2 git bundle\n'+commit.encode()+b' refs/heads/main\n\n'))
        self.assertEqual(repo_fetch.need(len(bundle),meta['pages'],meta['index'],meta['objects']),
                         len(bundle)+max(len(bundle),meta['pages']+meta['index'])+4096+32*meta['objects']+8*1024**2)
        # Every request carried the key; the key is in neither the bundle nor anything the fetcher left.
        self.assertTrue(server.seen);self.assertEqual({auth for _,auth in server.seen},{server.expected})
        authorization=base64.b64encode(('x-access-token:'+self.token).encode())
        for data in (bundle,*(path.read_bytes() for path in root.rglob('*') if path.is_file())):
            self.assertNotIn(self.token.encode(),data);self.assertNotIn(authorization,data)
        # Only the step-2 child reads stdin; no call after it has the key in its environment.
        child,=[(command,kwargs) for command,kwargs in calls if command[-2:]==['fetch',str(root)]]
        self.assertEqual(child[0][:3],[repo_fetch.sys.executable,'-I',os.path.abspath(repo_fetch.__file__)])
        self.assertNotEqual(child[1]['stdin'],subprocess.DEVNULL)
        for command,kwargs in calls:
            env=kwargs['env']
            self.assertNotIn('Authorization',json.dumps(env));self.assertNotIn(self.token[:12],json.dumps(env))
            self.assertFalse(any(part in json.dumps(env) for part in (authorization.decode(),self.token)))
            if command is not child[0]:self.assertEqual(kwargs['stdin'],subprocess.DEVNULL,command)
        self.assertEqual({command[3] for command,_ in calls if command[:3]==['git','-C',str(root)+'/r.git']},
                         {'rev-parse','cat-file','fsck','ls-tree','rev-list','bundle'})
        # Both environments cap git's threads and delta cache, and only the fetch environment holds the key.
        for env in (repo_fetch.plain(str(root)),repo_fetch.fetch_environment(str(root),self.request(server,commit))):
            config={env['GIT_CONFIG_KEY_%d'%n]:env['GIT_CONFIG_VALUE_%d'%n] for n in range(int(env['GIT_CONFIG_COUNT']))}
            self.assertEqual({k:config[k] for k in ('pack.threads','index.threads','core.deltaBaseCacheLimit')},
                             {'pack.threads':'1','index.threads':'1','core.deltaBaseCacheLimit':'32m'})
            self.assertEqual((config['protocol.allow'],config['credential.helper'],config['fsck.zeroPaddedFilemode']),('never','','ignore'))
            self.assertNotIn('transfer.fsckObjects',config);self.assertNotIn('fetch.fsckObjects',config)
        keyed=repo_fetch.fetch_environment(str(root),self.request(server,commit))
        self.assertIn('Authorization: Basic '+authorization.decode(),keyed.values())
        self.assertIn('http.'+server.base()+'/.extraHeader',keyed.values(),'the key goes only to the git base')
        self.assertIn('http.followRedirects',keyed.values())
        # Outside fixture mode git connects only to the pinned github.com address, over https.
        real={k:v for k,v in self.request(server,commit).items() if k!='base'}|{'ip':'1.2.3.4'}
        config=repo_fetch.fetch_environment('/fetch',real)
        values={config['GIT_CONFIG_KEY_%d'%n]:config['GIT_CONFIG_VALUE_%d'%n] for n in range(int(config['GIT_CONFIG_COUNT']))}
        self.assertEqual((values['http.curloptResolve'],values['protocol.https.allow'],values['http.https://github.com/.extraHeader']),
                         ('github.com:443:1.2.3.4','always','Authorization: Basic '+authorization.decode()))
        self.assertEqual(repo_fetch.checked(real,True),real)

    def test_a_wrong_key_a_missing_repository_and_a_redirect(self):
        _,commit,server=self.host()
        self.assertEqual(self.fetch(self.request(server,commit,token='github_'+'pat_'+'OTHER'+'z'*24))[0],10)
        self.assertEqual(self.fetch(self.request(server,commit,repo='example-org/missing'))[0],11)
        self.assertEqual(self.fetch(self.request(server,commit,repo='example-org/moved'))[0],11)
        self.assertFalse([path for path,_ in server.seen if 'elsewhere' in path],'no redirect is followed')

    def test_each_limit_gives_12(self):
        _,commit,server=self.host()
        for limit,value in (('files',fixture.FILES-1),('file',8),('bundle',100),('room',8*1024**2+4096),('inodes',fixture.FILES+fixture.DIRS+1023)):
            with self.subTest(limit=limit):
                code,output,_=self.fetch(self.request(server,commit,limits={limit:value}))
                self.assertEqual((code,output),(12,b''))
        self.assertEqual(self.fetch(self.request(server,commit,limits={'inodes':fixture.FILES+fixture.DIRS+1024}))[0],0)

    def test_the_strict_check_refuses_a_dotgit_tree_and_a_commit_without_email_and_passes_zero_padded_modes(self):
        for variant,expected in (('dotgit',13),('no_email',13),('zero_padded',0)):
            with self.subTest(variant=variant):
                _,commit,server=self.host(variant);code,output,_=self.fetch(self.request(server,commit))
                self.assertEqual(code,expected)
                if expected:self.assertEqual(output,b'')

    def test_another_tip_than_the_api_commit_gives_15_and_a_bad_request_gives_2(self):
        _,commit,server=self.host()
        self.assertEqual(self.fetch(self.request(server,'f'*40)),(15,b'',self.folder/'fetch-1'))
        good=self.request(server,commit)
        for bad in ({**good,'limits':{**good['limits'],'room':repo_fetch.REPO_ROOM+1}},{**good,'ip':'1.2.3.4'},{**good,'repo':'example-org/..'},
                    {**good,'branch':'-x'},{**good,'authorization':'not base64!'},{k:v for k,v in good.items() if k!='limits'},{**good,'extra':1},
                    {**good,'base':'http://user@127.0.0.1/git'}):
            self.assertEqual(self.fetch(bad)[0],2,bad)
        # A request that is not JSON, or over 8 KiB.
        for raw in (b'{',b'{"a":"'+b'x'*9000+b'"}'):
            stdin=self.folder/'raw.json';stdin.write_bytes(raw);root=self.folder/'raw';root.mkdir(exist_ok=True)
            with open(stdin,'rb') as source:self.assertEqual(repo_fetch.main(source.fileno(),io.BytesIO(),root=str(root)),2)


if __name__=='__main__':unittest.main()
