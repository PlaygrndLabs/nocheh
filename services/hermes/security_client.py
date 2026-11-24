"""Trusted parent-side streaming bridge; only scoped credentials reach the turn."""
import json
import os
import secrets
import sys
import threading
from urllib.request import Request,build_opener,ProxyHandler

LAUNCHER='http://hermes-agent-sb:8787'


def forward_steers(feed,credential,nonce):
    """Messages that join the running turn (ADR-0301), one stdin line each after the request, go to the launcher in
    order; it hands them to this turn's container only. One it cannot take is dropped, and its message runs on its own."""
    while True:
        try:line=feed.line()
        except Exception:return
        if not line:return
        try:
            value=json.loads(line)
            request=Request(LAUNCHER+'/v1/turn/steer',data=json.dumps({'archive_credential':credential,'nonce':nonce,**value},ensure_ascii=False).encode(),
                headers={'Authorization':'Bearer '+os.environ['AGENT_KEY'],'Content-Type':'application/json'})
            with build_opener(ProxyHandler({})).open(request,timeout=30) as response:response.read(1024)
        except Exception:
            continue


def main():
    from services.hermes.steering import Feed
    feed=Feed()
    raw=feed.line(2*1024*1024)
    headers={'Authorization':'Bearer '+os.environ['AGENT_KEY'],'Content-Type':'application/json'}
    body=json.loads(raw)
    if isinstance(body,dict) and body.get('steer') is True:
        # Names this turn to the launcher, so a late message never reaches a later turn of the same chat.
        nonce=secrets.token_hex(16);headers['X-Nocheh-Turn']=nonce
        threading.Thread(target=forward_steers,args=(feed,body['archive_credential'],nonce),daemon=True).start()
    request=Request(LAUNCHER+'/v1/turn',data=raw,headers=headers)
    with build_opener(ProxyHandler({})).open(request,timeout=235) as response:
        size=0
        for line in response:
            size+=len(line)
            if size>8*1024*1024:raise ValueError('turn_output_limit')
            json.loads(line)
            sys.stdout.buffer.write(line);sys.stdout.buffer.flush()

if __name__=='__main__':main()
