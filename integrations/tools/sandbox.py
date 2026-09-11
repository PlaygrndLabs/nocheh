"""Credential-free entrypoint inside a disposable, network-disabled container."""
import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
from html import escape
from pathlib import Path


def bounded(command, cwd, timeout=35, merge_errors=True):
    process=subprocess.Popen(command,cwd=cwd,env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8'},
        stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT if merge_errors else subprocess.DEVNULL,start_new_session=True)
    selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
    output=bytearray();deadline=time.monotonic()+timeout;reason=None
    try:
        while selector.get_map():
            if time.monotonic()>deadline: reason='time_limit';break
            for key,_ in selector.select(.1):
                data=os.read(key.fd,65536)
                if not data:selector.unregister(key.fd);continue
                output.extend(data)
                if len(output)>500000: reason='output_limit';break
            if reason:break
        if reason:os.killpg(process.pid,signal.SIGKILL)
        code=process.wait(timeout=2)
        return {'exit_code':code,'text':bytes(output[:500000]).decode('utf-8',errors='replace'),'limit':reason}
    finally:
        if process.poll() is None:os.killpg(process.pid,signal.SIGKILL);process.wait()
        selector.close();process.stdout.close()


class PageText(HTMLParser):
    def __init__(self):super().__init__();self.hidden=0;self.text=[];self.links=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','noscript'):self.hidden+=1
        if tag=='a':
            href=dict(attrs).get('href')
            if href and len(self.links)<100:self.links.append(href[:2048])
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript'):self.hidden=max(0,self.hidden-1)
    def handle_data(self,data):
        if not self.hidden and data.strip():self.text.append(data.strip())


class InertDocument(HTMLParser):
    """Keep text and link structure; discard every executable HTML capability."""
    tags={'p','div','span','main','article','section','header','footer','nav','h1','h2','h3','h4','h5','h6',
          'ul','ol','li','table','thead','tbody','tr','td','th','pre','code','blockquote','b','strong','i','em','br','hr','a'}
    def __init__(self):super().__init__();self.hidden=0;self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','noscript'):self.hidden+=1
        if self.hidden or tag not in self.tags:return
        href=dict(attrs).get('href','') if tag=='a' else ''
        # Links are inert during rendering and are returned for a later proposal.
        self.parts.append('<'+tag+(' href="'+escape(href,quote=True)+'"' if href else '')+'>')
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript'):self.hidden=max(0,self.hidden-1);return
        if not self.hidden and tag in self.tags:self.parts.append('</'+tag+'>')
    def handle_data(self,data):
        if not self.hidden:self.parts.append(escape(data))


def main():
    body=json.loads(sys.stdin.buffer.read(3*1024*1024))
    if body['kind']=='shell':result=bounded(['/bin/bash','--noprofile','--norc','-c',body['arguments']['command']],'/workspace')
    elif body['kind']=='browser':
        with tempfile.TemporaryDirectory(prefix='page-') as directory:
            inert=InertDocument();inert.feed(body['html'])
            page=Path(directory)/'page.html';page.write_text('<!doctype html><html><body>'+''.join(inert.parts)+'</body></html>')
            raw=bounded(['/usr/bin/chromium','--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
                '--disable-background-networking','--no-first-run',
                '--virtual-time-budget=2000','--dump-dom',page.as_uri()],'/tmp',merge_errors=False)
            if raw['exit_code']!=0 or raw['limit']:raise RuntimeError('browser_unavailable')
            parser=PageText();parser.feed(raw['text'])
            result={'text':'\n'.join(parser.text)[:100000],'links':parser.links,'mode':'offline_document','url':body['arguments']['url']}
    else:raise ValueError('sandbox_tool_denied')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
