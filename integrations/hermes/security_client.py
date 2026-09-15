"""Trusted parent-side streaming bridge; only scoped credentials reach the turn."""
import json
import os
import sys
from urllib.request import Request,build_opener,ProxyHandler

def main():
    raw=sys.stdin.buffer.read(2*1024*1024+1)
    if len(raw)>2*1024*1024:raise ValueError('turn_size_limit')
    request=Request('http://hermes-agent-launcher:8787/v1/turn',data=raw,headers={
      'Authorization':'Bearer '+os.environ['SERVICE_TOKEN'],'Content-Type':'application/json'})
    with build_opener(ProxyHandler({})).open(request,timeout=235) as response:
        size=0
        for line in response:
            size+=len(line)
            if size>8*1024*1024:raise ValueError('turn_output_limit')
            json.loads(line)
            sys.stdout.buffer.write(line);sys.stdout.buffer.flush()

if __name__=='__main__':main()
