"""Approved tools: isolated Docker execution and exact public HTTPS requests."""
from tools.paths import ROOT as REPO_ROOT
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import uuid
import sys
import signal
import selectors
import time
from pathlib import Path
from urllib.parse import urlsplit


def public_target(address,resolver=socket.getaddrinfo):
    url=urlsplit(address)
    if url.scheme!='https' or not url.hostname or url.username or url.password or url.fragment or url.port not in (None,443):raise ValueError('public_https_required')
    addresses={item[4][0] for item in resolver(url.hostname,443,type=socket.SOCK_STREAM)}
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):raise ValueError('private_destination_denied')
    return url,sorted(addresses)[0]


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self,hostname,address):super().__init__(hostname,443,timeout=15,context=ssl.create_default_context());self.address=address
    def connect(self):
        raw=socket.create_connection((self.address,443),timeout=self.timeout)
        try:self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except Exception:raw.close();raise


def https_request(address,body=None,headers=None):
    url,ip=public_target(address);connection=PinnedHTTPS(url.hostname,ip)
    try:
        request_headers={'Accept':'application/json, text/html','Accept-Encoding':'identity','User-Agent':'Nocheh-approved-action/1'}
        request_headers.update(headers or {})
        encoded=None if body is None else json.dumps(body,separators=(',',':')).encode()
        if encoded is not None:request_headers['Content-Type']='application/json'
        connection.request('GET' if encoded is None else 'POST',(url.path or '/')+('?' +url.query if url.query else ''),body=encoded,headers=request_headers)
        response=connection.getresponse()
        if response.status==401:raise RuntimeError('remote_unauthorized')
        if not 200<=response.status<300:raise RuntimeError('remote_response_rejected')
        if response.getheader('Content-Encoding','identity')!='identity':raise RuntimeError('encoded_response_denied')
        content=response.read(2*1024*1024+1)
        if len(content)>2*1024*1024:raise RuntimeError('remote_response_limit')
        return content,{key.lower():value for key,value in response.getheaders()}
    finally:connection.close()


def events(data):
    """JSON-RPC messages of a streamed (text/event-stream) MCP response."""
    for block in data.decode('utf-8',errors='replace').replace('\r\n','\n').split('\n\n'):
        payload='\n'.join(line[5:].lstrip(' ') for line in block.split('\n') if line.startswith('data:'))
        if payload:
            try:yield json.loads(payload)
            except ValueError:raise RuntimeError('mcp_response_rejected') from None


def mcp_call(args,request=https_request,state=None):
    # Explicitly implement the stable 2025-11-25 transport. No server-initiated
    # capabilities, ambient credentials or automatic retries are inherited. A
    # connected service adds only the owner's own sign-in for that service.
    url,auth,versions=args.get('url'),{},('2025-11-25',)
    if args.get('connection')=='notion':
        from tools.operations.connections import notion
        url,versions=notion.MCP_URL,notion.VERSIONS
        auth={'Authorization':'Bearer '+notion.bearer(state)}
    def rpc(body,headers=None):
        data,received=request(url,body,{'Accept':'application/json, text/event-stream',**auth,**(headers or {})})
        if not data:return None,received
        kind=received.get('content-type','')
        if 'text/event-stream' in kind and auth:
            # Notion may stream its answer; only the reply to this request is read.
            response=next((item for item in events(data) if isinstance(item,dict) and 'id' in item and item.get('id')==body.get('id')),None)
            if response is None:raise RuntimeError('mcp_response_rejected')
        elif 'application/json' in kind:response=json.loads(data)
        else:raise RuntimeError('mcp_json_transport_required')
        if not isinstance(response,dict) or response.get('jsonrpc')!='2.0' or 'method' in response or response.get('id')!=body.get('id') or 'error' in response:raise RuntimeError('mcp_response_rejected')
        return response.get('result'),received
    try:init,received=rpc({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':versions[0],'capabilities':{},'clientInfo':{'name':'nocheh','version':'0.2'}}})
    except RuntimeError as error:
        # A refused sign-in on the first request means nothing reached the tool.
        if auth and str(error)=='remote_unauthorized':raise ValueError('notion_reconnect_needed') from None
        raise
    if not isinstance(init,dict) or init.get('protocolVersion') not in versions:raise RuntimeError('mcp_protocol_unsupported')
    headers={'MCP-Protocol-Version':init['protocolVersion'],'Accept':'application/json, text/event-stream'}
    session=received.get('mcp-session-id')
    if session:
        if not re.fullmatch(r'[\x21-\x7e]{1,256}',session):raise RuntimeError('mcp_session_invalid')
        headers['Mcp-Session-Id']=session
    rpc({'jsonrpc':'2.0','method':'notifications/initialized'},headers)
    operation={'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}} if args.get('operation')=='list' else {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':args['tool'],'arguments':args['input']}}
    result,_=rpc(operation,headers)
    return {'response':result,'protocol':init['protocolVersion']}


def workspace(state,profile):
    if not re.fullmatch(r'[\w-]{1,128}',profile):raise ValueError('profile_denied')
    base=Path(state)/'hermes/profiles';home=base/profile
    if base.is_symlink() or home.is_symlink() or not home.is_dir() or home.resolve().parent!=base.resolve():raise ValueError('profile_denied')
    path=home/'workspace'
    if path.is_symlink():raise ValueError('workspace_path_denied')
    path.mkdir(mode=0o700,exist_ok=True)
    if path.resolve().parent!=home.resolve():raise ValueError('workspace_path_denied')
    return path.resolve()


def sandbox_command(state,action,name):
    command=['docker','run','--pull=never','--rm','-i','--name',name,'--network=none','--read-only','--cap-drop=ALL',
        '--security-opt=no-new-privileges','--pids-limit=128','--memory=768m','--cpus=1',
        '--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--ulimit','fsize=10485760:10485760','--log-driver=none']
    if action['kind']=='shell':command+=['--mount','type=bind,src='+str(workspace(state,action['profile']))+',dst=/workspace']
    return command+['nocheh-tools:local']


def execute(state,action,request=https_request,run=subprocess.run,container_name=None):
    args=action['arguments']
    if action['kind']=='mcp':
        try:return mcp_call(args,request,state)
        except ValueError as error:
            # The Notion sign-in is missing or must be renewed: nothing was sent.
            if str(error) in ('notion_not_connected','notion_reconnect_needed','notion_unavailable'):return {'exit_code':1,'error':str(error)}
            raise
    body={'kind':action['kind'],'arguments':args}
    if action['kind']=='browser':
        data,headers=request(args['url'])
        if 'text/html' not in headers.get('content-type',''):raise RuntimeError('browser_html_required')
        body['html']=data.decode('utf-8',errors='replace')
    name=container_name or 'nocheh-tool-'+uuid.uuid4().hex
    try:
        result=run(sandbox_command(state,action,name),input=json.dumps(body).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=50)
        if result.returncode or len(result.stdout)>1024*1024:raise RuntimeError('sandbox_execution_failed')
        return json.loads(result.stdout)
    finally:
        # The deterministic name belongs only to this action; timeout never leaves
        # its container running. No user command or path enters a host shell.
        run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)


def bounded_execute(state,action):
    """An overall process deadline also bounds DNS and slow response streams."""
    name='nocheh-tool-'+uuid.uuid4().hex
    env={key:os.environ[key] for key in ('PATH','HOME','LANG','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG') if key in os.environ}
    process=subprocess.Popen([sys.executable,'-m','tools.operations.security.tool_execution'],cwd=REPO_ROOT,env=env,
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    selector=selectors.DefaultSelector();output=bytearray();deadline=time.monotonic()+75
    try:
        process.stdin.write(json.dumps({'state':str(state),'action':action,'container_name':name}).encode());process.stdin.close()
        selector.register(process.stdout,selectors.EVENT_READ)
        while selector.get_map():
            if time.monotonic()>deadline:raise TimeoutError('tool_deadline')
            for key,_ in selector.select(.1):
                data=os.read(key.fd,65536)
                if not data:selector.unregister(key.fd);continue
                output.extend(data)
                if len(output)>1024*1024:raise RuntimeError('tool_result_limit')
        if process.wait(timeout=2):raise RuntimeError('tool_process_failed')
        return json.loads(output)
    finally:
        if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
        process.stdout.close();selector.close()
        # The isolated helper may be killed before its finally block runs.
        if action['kind']!='mcp':
            subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)


if __name__=='__main__':
    try:
        body=json.loads(sys.stdin.buffer.read(128*1024))
        print(json.dumps(execute(body['state'],body['action'],container_name=body['container_name']),ensure_ascii=False))
    except Exception:raise SystemExit(1)
