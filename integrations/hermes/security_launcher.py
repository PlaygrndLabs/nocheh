"""Trusted Compose launcher. Docker authority never enters an agent container."""
import hmac
import http.client
import json
import os
import re
import select
import socket
import threading
import uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request,build_opener,ProxyHandler
from .isolated_profile import DATA_DIRS

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

def container_spec(profile,host_root,image,network,uid,gid):
    if not re.fullmatch(r'nocheh-[a-f0-9]{24}',profile):raise ValueError('invalid_isolated_profile')
    root=Path(host_root)
    if not root.is_absolute() or any(c in str(root) for c in '\r\n,:'):raise ValueError('invalid_host_profile_root')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',image):raise ValueError('pinned_runtime_image_required')
    if not re.fullmatch(r'[\w-]{1,128}',network):raise ValueError('invalid_isolation_network')
    if not all(type(x) is int and x>0 for x in (uid,gid)):raise ValueError('unprivileged_identity_required')
    mounts=[{'Type':'bind','Source':str(root/profile/'config.yaml'),'Target':'/profile/config.yaml','ReadOnly':True}]
    mounts += [{'Type':'bind','Source':str(root/profile/name),'Target':'/profile/'+name,'ReadOnly':False} for name in DATA_DIRS]
    return {'Image':image,'User':f'{uid}:{gid}','WorkingDir':'/workspace',
      'Cmd':['python','-m','integrations.hermes.assistant_turn'],
      'Env':['HOME=/tmp/home','HERMES_HOME=/profile','NOCHEH_CAPTURE_ENABLED=0','NOCHEH_ISOLATED_TURN=1',
             'ARCHIVE_URL=http://security:8786','GUARD_URL=http://security:8786'],
      'OpenStdin':True,'StdinOnce':True,'AttachStdin':True,'AttachStdout':True,'AttachStderr':False,'Tty':False,
      'Labels':{'nocheh.role':'isolated-turn','nocheh.profile':profile},
      'HostConfig':{'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
        'NetworkMode':network,'Dns':['127.0.0.1'],'Mounts':mounts,'PidsLimit':128,'Memory':2*1024**3,'NanoCpus':2*10**9,
        'Tmpfs':{'/tmp':f'rw,nosuid,nodev,size=128m,uid={uid},gid={gid}',
                 '/profile':f'rw,nosuid,nodev,size=32m,uid={uid},gid={gid}'},
        'LogConfig':{'Type':'none'},'Init':True},
    }

def validate_local_profile(profile,root=Path('/profiles')):
    path=root/profile
    if path.is_symlink() or not path.is_dir() or path.parent.resolve()!=root.resolve():raise ValueError('profile_mount_denied')
    for name in ('config.yaml',*DATA_DIRS):
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

SLOTS=threading.BoundedSemaphore(4)
ACTIVE=set()
ACTIVE_LOCK=threading.Lock()
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
        identifier=None;profile=None;reserved=False;closed=threading.Event()
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=2*1024*1024:raise ValueError('turn_size_limit')
            body=json.loads(self.rfile.read(length));credential=body['archive_credential']
            request=Request('http://security:8786/v1/security/binding',headers={'Authorization':'Bearer '+credential})
            with build_opener(ProxyHandler({})).open(request,timeout=10) as response:binding=json.load(response)
            profile=binding['profile'];validate_local_profile(profile)
            with ACTIVE_LOCK:
                if profile in ACTIVE:raise ValueError('profile_busy')
                ACTIVE.add(profile);reserved=True
            if body.get('model')!=binding['model'] or body.get('owner')!=binding['owner'] or body.get('chat_id')!=binding['scope']:raise ValueError('turn_binding_mismatch')
            from .security_transport import scoped_transport
            body.update(scoped_transport(credential,body['api_mode']))
            spec=container_spec(profile,os.environ['NOCHEH_HOST_PROFILES'],self.server.image,self.server.network,int(os.environ['NOCHEH_UID']),int(os.environ['NOCHEH_GID']))
            identifier=docker('POST','/containers/create?name=nocheh-turn-'+uuid.uuid4().hex,spec)['Id']
            self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.send_header('Cache-Control','no-store');self.end_headers()
            def watch():
                while not closed.wait(.2):
                    if select.select([self.connection],[],[],0)[0] and not self.connection.recv(1,socket.MSG_PEEK):
                        try:docker('POST','/containers/'+identifier+'/kill')
                        except Exception:pass
                        return
            watcher=threading.Thread(target=watch,daemon=True);watcher.start()
            for content in attach(identifier,body):self.wfile.write(content);self.wfile.flush()
        except Exception:
            # Deliberately omit exception messages, Docker bodies and request material.
            if identifier is None:self.send_error(503,'isolated_turn_unavailable')
        finally:
            closed.set()
            if identifier:
                try:docker('DELETE','/containers/'+identifier+'?force=true')
                except Exception:pass
            if reserved:
                with ACTIVE_LOCK:ACTIVE.discard(profile)
            SLOTS.release();self.close_connection=True

def main():
    network=os.environ.get('NOCHEH_AGENT_NETWORK','nocheh-agent')
    description=docker('GET','/networks/'+network)
    if description.get('Internal') is not True:raise RuntimeError('internal_network_required')
    image=docker('GET','/images/nocheh-hermes:local/json')['Id']
    # Remove orphaned turns from a previous launcher instance. Never restart them.
    for container in docker('GET','/containers/json?all=true'):
        if container.get('Labels',{}).get('nocheh.role')=='isolated-turn':docker('DELETE','/containers/'+container['Id']+'?force=true')
    server=ThreadingHTTPServer(('0.0.0.0',8787),Handler);server.image=image;server.network=network
    server.serve_forever()

if __name__=='__main__':main()
