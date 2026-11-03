"""Sealed job box: launcher logic without Docker, the in-box writer, and the box token's wiring."""
import errno
import hashlib
import http.client
import io
import json
import os
import re
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import unquote
from . import security_launcher as launcher
from tools.runtime import box_put

JOB='a'*64

def box(**changes):
    return {'job':JOB,'chat':'chat-1','from':None,'to':None,'generation':'gen-1','mode':'on','valid_from_epoch':5,
            'expires':'2999-01-01T00:00:00.000Z',**changes}

def key(entry):return tuple(launcher.box_labels(entry)['nocheh.box.'+k] for k in launcher.BOX_KEY)

def later(seconds=60):return time.monotonic()+seconds

class FakeDocker:
    """Containers and volumes as the Engine API lists them; label filters as Docker applies them."""
    def __init__(self):self.containers={};self.volumes={};self.calls=[];self.in_use=set();self.killed=[];self.image='sha256:'+'e'*64
    def add(self,name,labels,state='running',volume=True):
        identifier=hashlib.sha256(name.encode()).hexdigest()
        self.containers[identifier]={'Id':identifier,'Names':['/'+name],'Labels':labels,'State':state}
        if volume:self.volumes[name]={'Name':name,'Labels':{k:v for k,v in labels.items() if k in ('nocheh.role','nocheh.box.network','nocheh.box.job')}}
        return identifier
    def __call__(self,method,path,body=None):
        self.calls.append((method,path,body))
        route=path.split('?')[0]
        if method=='GET' and route=='/containers/json':
            return [dict(c) for c in self.containers.values() if c['Labels'].get('nocheh.role')=='job-box']
        if method=='GET' and route=='/volumes':
            return {'Volumes':[v for v in self.volumes.values() if v['Labels'].get('nocheh.role')=='job-box'] or None}
        if method=='GET' and route.startswith('/images/'):return {'Id':self.image}
        if method=='GET' and route.startswith('/containers/'):
            container=self.containers.get(route.split('/')[2])
            if not container:raise RuntimeError('container_operation_failed')
            return {'State':{'Running':container['State']=='running'}}
        if method=='POST' and route=='/volumes/create':self.volumes[body['Name']]=body;return body
        if method=='POST' and route=='/containers/create':
            name=path.split('name=')[1];identifier=self.add(name,body['Labels'],'created',volume=False);return {'Id':identifier}
        if method=='POST' and route.endswith('/start'):self.containers[route.split('/')[2]]['State']='running';return {}
        if method=='POST' and route.endswith('/kill'):self.killed.append(route.split('/')[2]);return {}
        if method=='DELETE' and route.startswith('/containers/'):
            if self.containers.pop(route.split('/')[2],None) is None:raise RuntimeError('container_operation_failed')
            return {}
        if method=='DELETE' and route.startswith('/volumes/'):
            name=route.split('/')[2]
            if name in self.in_use or self.volumes.pop(name,None) is None:raise RuntimeError('container_operation_failed')
            return {}
        raise AssertionError((method,path))
    def names(self):return sorted(c['Names'][0][1:] for c in self.containers.values())

class Chat:
    """A fake /v1/box/chat: pages by cursor, and the puts the launcher made into the box."""
    def __init__(self,pages,delay=0):self.pages=pages;self.cursors=[];self.puts=[];self.deadlines=[];self.delay=delay
    def security(self,path,headers,timeout,limit=None):
        if path=='/v1/box/live':raise AssertionError(path)
        self.headers=headers;self.limit=limit;cursor=path.split('?cursor=')[1] if '?cursor=' in path else None
        self.cursors.append(cursor);time.sleep(self.delay);return self.pages[cursor]
    def put(self,identifier,name,data,until):self.puts.append((name,data));self.deadlines.append(until)
    def manifest(self):return json.loads(next(data for name,data in reversed(self.puts) if name=='manifest.json'))

def page(records,following=None,checking=0):
    return {'records':[{'id':r,'text':'member: hello '+r} for r in records],'next':following,'checking':checking,'complete':following is None}

def fresh_state():return {'complete':False,'next':None,'parts':0,'records':0,'checking':0,'full':False,'seen':set(),'pending':None}

ENV={'NOCHEH_BOX_TOKEN':'t'*40,'NOCHEH_GID':'1000'}

class Security(ThreadingHTTPServer):
    """A fake nocheh-security: turn bindings by credential, answered after delay, and one raw /v1/box/chat body."""
    def __init__(self):
        self.bindings={};self.chat=b'{}';self.delay=0;self.asked=[];outer=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                if self.path=='/v1/security/binding':outer.asked.append(time.monotonic());time.sleep(outer.delay)
                raw=json.dumps(outer.bindings[self.headers['Authorization'][7:]]).encode() if self.path=='/v1/security/binding' else outer.chat
                self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        super().__init__(('127.0.0.1',0),Handler);threading.Thread(target=self.serve_forever,daemon=True).start()
    def url(self):return 'http://127.0.0.1:%d'%self.server_address[1]
    def close(self):self.shutdown();self.server_close()

class BoxLauncherTests(unittest.TestCase):
    def setUp(self):
        launcher.BOXES.clear();launcher.ABNORMAL.clear();self.addCleanup(launcher.BOXES.clear);self.addCleanup(launcher.ABNORMAL.clear)
        os.environ.pop('NOCHEH_AGENT_NETWORK',None)

    def test_box_spec_is_sealed(self):
        labels=launcher.box_labels(box())
        spec=launcher.box_spec('sha256:'+'e'*64,1000,'nocheh-box-'+'c'*24,labels);host=spec['HostConfig'];encoded=json.dumps(spec)
        self.assertEqual((spec['User'],spec['Cmd']),('65532:65532',['python3','-I','/opt/box/box_server.py']))
        self.assertEqual(spec['Env'],['NOCHEH_BOX_GID=1000','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8','HOME=/work'])
        self.assertEqual((host['NetworkMode'],host['ReadonlyRootfs'],host['CapDrop'],host['SecurityOpt'],host['GroupAdd'],host['Init']),
                         ('none',True,['ALL'],['no-new-privileges:true'],['1000'],True))
        self.assertEqual((host['PidsLimit'],host['Memory'],host['MemorySwap'],host['NanoCpus'],host['OomScoreAdj'],host['IpcMode'],host['LogConfig']),
                         (128,1024**3,1024**3,10**9,1000,'private',{'Type':'none'}))
        self.assertEqual({u['Name']:(u['Soft'],u['Hard']) for u in host['Ulimits']},{'nofile':(1024,1024),'core':(0,0),'fsize':(100*1024**2,)*2})
        self.assertEqual(host['Tmpfs'],{'/work':'rw,exec,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700',
                                        '/tmp':'rw,noexec,nosuid,nodev,size=64m',
                                        '/tmp/hermes-results':'ro,noexec,nosuid,nodev,size=64k',
                                        '/chat':'rw,noexec,nosuid,nodev,size=128m,uid=65533,gid=65533,mode=0755'})
        self.assertEqual(host['Mounts'],[{'Type':'volume','Source':'nocheh-box-'+'c'*24,'Target':'/run/box','ReadOnly':False}])
        self.assertNotIn('Binds',host)
        for value in ('docker.sock','TOKEN','chat-1','member'):self.assertNotIn(value,encoded)
        self.assertEqual(spec['Labels'],{'nocheh.role':'job-box','nocheh.box.network':'nocheh-agent','nocheh.box.job':JOB,'nocheh.box.generation':'gen-1','nocheh.box.mode':'on',
                                         'nocheh.box.valid_from':'5','nocheh.box.expires':'2999-01-01T00:00:00.000Z'})
        # Nothing box commands put next to the socket runs, is a device or carries setuid, in the box or the turn.
        self.assertEqual(launcher.volume_spec('nocheh-box-'+'c'*24,1000,labels)['DriverOpts'],
                         {'type':'tmpfs','device':'tmpfs','o':'size=1m,uid=65532,gid=1000,mode=0710,nosuid,nodev,noexec'})
        with self.assertRaises(ValueError):launcher.box_spec('nocheh-box:local',1000,'nocheh-box-'+'c'*24,labels)
        with self.assertRaises(ValueError):launcher.box_spec('sha256:'+'e'*64,0,'nocheh-box-'+'c'*24,labels)
        with self.assertRaises(ValueError):launcher.box_spec('sha256:'+'e'*64,1000,'other-box',labels)

    def test_malformed_box_bindings_name_no_box(self):
        self.assertEqual(launcher.box_labels(box(generation=3))['nocheh.box.generation'],'3')
        for bad in (box(job='../x'),box(mode='off'),box(valid_from_epoch=True),box(valid_from_epoch=-1),box(expires='soon'),
                    box(expires='2999-01-01T00:00:00'),box(generation='a b'),None,[]):
            with self.assertRaises(ValueError,msg=repr(bad)):launcher.box_labels(bad)

    def test_fill_writes_pages_then_manifest_and_resumes(self):
        chat=Chat({None:page(['1','2'],'c2'),'c2':page(['3'],'c3'),'c3':page(['4'])})
        launcher.BOXES['box']=fresh_state()
        with patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),patch.dict(os.environ,ENV):
            # The core went away after one page: the next step resumes from its cursor.
            launcher.fill('box','step.credential',lambda:len(chat.cursors)>=1,later())
            self.assertEqual([n for n,_ in chat.puts],['part-00001.jsonl','manifest.json'])
            self.assertEqual(chat.manifest(),{'complete':False,'next':'c2','parts':1,'records':2,'checking':0,'full':False})
            launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual(chat.cursors,[None,'c2','c3'])
        self.assertEqual(chat.headers,{'Authorization':'Bearer step.credential','X-Nocheh-Box-Token':'t'*40})
        self.assertEqual([n for n,_ in chat.puts],['part-00001.jsonl','manifest.json','part-00002.jsonl','manifest.json','part-00003.jsonl','manifest.json'])
        self.assertEqual(chat.puts[0][1],b'{"id":"1","text":"member: hello 1"}\n{"id":"2","text":"member: hello 2"}\n')
        self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':3,'records':4,'checking':0,'full':False})
        with patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put):
            launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual(len(chat.cursors),3,'a complete copy with nothing being checked is not read again')

    def test_fill_stops_at_its_deadline_and_the_next_step_resumes(self):
        pages={None if n==0 else 'c%d'%n:page([str(n)],'c%d'%(n+1) if n<99 else None) for n in range(100)}
        chat=Chat(pages,delay=.03);launcher.BOXES['box']=fresh_state();started=[]
        def security(*args,**kwargs):started.append(time.monotonic());return chat.security(*args,**kwargs)
        with patch.object(launcher,'security',security),patch.object(launcher,'put',chat.put),patch.object(launcher,'WRITE_SECONDS',.1),\
                patch.dict(os.environ,ENV):
            began=time.monotonic();launcher.fill('box','step.credential',lambda:False,began+.3);took=time.monotonic()-began
            self.assertLess(took,.5);self.assertLess(len(chat.cursors),20)
            fetched=len(chat.cursors);state=launcher.BOXES['box']
            self.assertEqual(chat.manifest(),{'complete':False,'next':'c%d'%fetched,'parts':fetched,'records':fetched,'checking':0,'full':False})
            self.assertEqual(state['next'],'c%d'%fetched)
            # No page is read in the last WRITE_SECONDS, which are kept for writing the last one; every write ends by the deadline.
            self.assertLess(max(started),began+.2);self.assertTrue(all(until==began+.3 for until in chat.deadlines))
            chat.delay=0;launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual(chat.cursors[fetched],'c%d'%fetched,'the next step reads on from the manifest cursor')
        self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':100,'records':100,'checking':0,'full':False})

    def test_a_page_is_read_only_until_the_time_kept_for_writing(self):
        chat=Chat({None:page(['1'],'c2'),'c2':page(['2'])});launcher.BOXES['box']=fresh_state();timeouts=[]
        def security(path,headers,timeout,limit=None):timeouts.append(timeout);return chat.security(path,headers,timeout,limit)
        with patch.object(launcher,'security',security),patch.object(launcher,'put',chat.put),patch.dict(os.environ,ENV):
            began=time.monotonic();until=began+30;launcher.fill('box','step.credential',lambda:False,until)
        # A slow page gives up before the last WRITE_SECONDS, which are kept for writing its part and the manifest.
        self.assertEqual(len(timeouts),2);self.assertTrue(all(0<t<=until-launcher.WRITE_SECONDS-began for t in timeouts),timeouts)
        self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':2,'records':2,'checking':0,'full':False})

    def test_records_still_checked_are_fetched_again_from_the_start(self):
        chat=Chat({None:page(['1'],'c2'),'c2':page(['2'],checking=1)})
        launcher.BOXES['box']=fresh_state()
        with patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),patch.dict(os.environ,ENV):
            launcher.fill('box','step.credential',lambda:False,later())
            self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':2,'records':2,'checking':1,'full':False})
            # The checked record arrived since; only it is written, in a new part.
            chat.pages={None:page(['1'],'c2'),'c2':page(['2','3'])}
            launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual(chat.cursors,[None,'c2',None,'c2'])
        self.assertEqual([n for n,_ in chat.puts][4:],['manifest.json','part-00003.jsonl','manifest.json'])
        self.assertEqual(chat.puts[5][1],b'{"id":"3","text":"member: hello 3"}\n')
        self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':3,'records':3,'checking':0,'full':False})

    def test_a_failed_part_is_written_again_under_its_own_name_with_the_same_lines(self):
        chat=Chat({None:page(['1'],'c2'),'c2':page(['2'])});failures=[RuntimeError('box_fill_failed')]
        def put(identifier,name,data,until):
            if failures:raise failures.pop()
            chat.put(identifier,name,data,until)
        launcher.BOXES['box']=fresh_state()
        with patch.object(launcher,'security',chat.security),patch.object(launcher,'put',put),patch.dict(os.environ,ENV):
            with self.assertRaises(RuntimeError):launcher.fill('box','step.credential',lambda:False,later())
            self.assertEqual(chat.puts,[])
            # The page changed since: the failed part still goes first, exactly as it was, and the new record after it.
            chat.pages={None:page(['1','1b'],'c2'),'c2':page(['2'])}
            launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual([n for n,_ in chat.puts],['part-00001.jsonl','manifest.json','part-00002.jsonl','manifest.json','part-00003.jsonl','manifest.json'])
        self.assertEqual(chat.puts[0][1],b'{"id":"1","text":"member: hello 1"}\n')
        self.assertEqual(json.loads(chat.puts[1][1]),{'complete':False,'next':None,'parts':1,'records':1,'checking':0,'full':False})
        self.assertEqual(chat.puts[2][1],b'{"id":"1b","text":"member: hello 1b"}\n')
        # parts is the number of part files in /chat.
        self.assertEqual(chat.manifest(),{'complete':True,'next':None,'parts':3,'records':3,'checking':0,'full':False})

    def test_a_part_with_no_room_ends_the_copy_for_good(self):
        chat=Chat({None:page(['1'],'c2'),'c2':page(['2'],'c3'),'c3':page(['3'])});failures=[RuntimeError('box_fill_failed')]
        def put(identifier,name,data,until):
            if name=='part-00002.jsonl':raise RuntimeError('box_chat_full')
            if name=='manifest.json' and json.loads(data)['full'] and failures:raise failures.pop()
            chat.put(identifier,name,data,until)
        launcher.BOXES['box']=fresh_state()
        with patch.object(launcher,'security',chat.security),patch.object(launcher,'put',put),patch.dict(os.environ,ENV):
            # The manifest saying so was not written in time: a later step finds no room again and writes it.
            with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):launcher.fill('box','step.credential',lambda:False,later())
            self.assertEqual((launcher.BOXES['box']['full'],launcher.BOXES['box']['pending']),(False,None))
            self.assertEqual(chat.manifest(),{'complete':False,'next':'c2','parts':1,'records':1,'checking':0,'full':False})
            launcher.fill('box','step.credential',lambda:False,later())
            self.assertEqual(chat.manifest(),{'complete':False,'next':'c2','parts':1,'records':1,'checking':0,'full':True})
            self.assertEqual((launcher.BOXES['box']['full'],launcher.BOXES['box']['pending']),(True,None))
            # Final for this box: later steps read no page and write nothing.
            asked,written=list(chat.cursors),list(chat.puts)
            launcher.fill('box','step.credential',lambda:False,later())
        self.assertEqual((chat.cursors,chat.puts),(asked,written));self.assertEqual(asked,[None,'c2','c2'])

    def test_malformed_chat_pages_are_refused(self):
        for bad in ({'records':[{}],'next':None,'checking':0,'complete':False},{'records':['member: hello'],'next':None,'checking':0,'complete':True},
                    {'records':[{}]*201,'next':None,'checking':0,'complete':True},{'records':[],'next':None,'checking':True,'complete':True}):
            with patch.object(launcher,'security',return_value=bad),patch.dict(os.environ,ENV),self.assertRaises(ValueError):
                launcher.chat_page('step.credential',None,later(5))
        with patch.dict(os.environ,{'NOCHEH_BOX_TOKEN':'short'}),self.assertRaises(ValueError):launcher.chat_page('step.credential',None,later(5))

    def test_a_chat_page_is_read_up_to_the_brokers_8_mib(self):
        security=Security();self.addCleanup(security.close)
        def body(size):
            raw=json.dumps({'records':[{'text':''}],'next':None,'checking':0,'complete':True}).encode()
            return raw.replace(b'"text": ""',b'"text": "'+b'x'*(size-len(raw))+b'"')
        with patch.dict(os.environ,{**ENV,'NOCHEH_SECURITY_URL':security.url()}):
            security.chat=body(8*1024*1024);self.assertEqual(len(security.chat),8*1024*1024)
            records,*_=launcher.chat_page('step.credential',None,later(10))
            self.assertEqual(len(records[0]['text']),8*1024*1024-len(body(0)))
            security.chat=body(8*1024*1024+1)
            with self.assertRaisesRegex(ValueError,'security_response_limit'):launcher.chat_page('step.credential',None,later(10))

    def test_box_is_reused_only_under_the_same_guard_state(self):
        docker=FakeDocker();chat=Chat({None:page(['1'])})
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.dict(os.environ,ENV):
            until=later();first,name=launcher.prepare_box(box(),'step.credential',lambda:False,2,until)
            created=[c for c in docker.calls if c[0]=='POST']
            self.assertEqual([c[1].split('?')[0] for c in created],['/volumes/create','/containers/create','/containers/'+first+'/start'])
            self.assertEqual(created[1][2],launcher.box_spec(docker.image,1000,name,launcher.box_labels(box())))
            self.assertEqual(created[0][2]['DriverOpts']['o'],'size=1m,uid=65532,gid=1000,mode=0710,nosuid,nodev,noexec')
            self.assertEqual([n for n,_ in chat.puts],['manifest.json','part-00001.jsonl','manifest.json'])
            # The new box's first manifest and its fill share the request's one deadline.
            self.assertEqual(chat.deadlines,[until]*3)
            docker.calls.clear()
            self.assertEqual(launcher.prepare_box(box(),'step.credential',lambda:False,2,later()),(first,name))
            self.assertFalse([c for c in docker.calls if c[0]!='GET'],'a reused box is not touched')
            # A non-quiet guard change: destroy and refill, with the image resolved again.
            docker.image='sha256:'+'f'*64
            second,renamed=launcher.prepare_box(box(valid_from_epoch=6),'step.credential',lambda:False,2,later())
            self.assertNotEqual((second,renamed),(first,name))
            self.assertEqual(docker.names(),[renamed]);self.assertNotIn(name,docker.volumes);self.assertNotIn(first,launcher.BOXES)
            self.assertEqual(docker.containers[second]['Labels']['nocheh.box.valid_from'],'6')
            self.assertIn(('POST','/containers/create?name='+renamed,launcher.box_spec('sha256:'+'f'*64,1000,renamed,launcher.box_labels(box(valid_from_epoch=6)))),docker.calls)
            # A box that stopped is replaced too.
            docker.containers[second]['State']='exited'
            third,_=launcher.prepare_box(box(valid_from_epoch=6),'step.credential',lambda:False,2,later())
            self.assertNotEqual(third,second)
            # So is a running box with the same labels that this launcher did not fill: its /chat is unknown.
            launcher.BOXES.clear();fourth,renamed=launcher.prepare_box(box(valid_from_epoch=6),'step.credential',lambda:False,2,later())
            self.assertNotEqual(fourth,third);self.assertEqual(docker.names(),[renamed])

    def test_a_box_after_an_abnormal_end_is_replaced(self):
        docker=FakeDocker();chat=Chat({None:page(['1'])})
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.dict(os.environ,ENV):
            first,name=launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
            # The job's last box turn did not end by itself: what it started may still run there, so the box goes.
            launcher.ABNORMAL.add(JOB)
            second,renamed=launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
            self.assertNotEqual(second,first);self.assertEqual(docker.names(),[renamed]);self.assertNotIn(name,docker.volumes)
            self.assertEqual(launcher.ABNORMAL,set(),'the new box starts clean')
            self.assertEqual(launcher.prepare_box(box(),'step.credential',lambda:False,2,later()),(second,renamed))
            # Another job's abnormal end leaves this box alone.
            launcher.ABNORMAL.add('b'*64)
            self.assertEqual(launcher.prepare_box(box(),'step.credential',lambda:False,2,later()),(second,renamed))
        self.assertEqual(launcher.ABNORMAL,{'b'*64})

    def test_box_limit_tag_image_expiry_and_token_stop_a_box(self):
        docker=FakeDocker();chat=Chat({None:page([])})
        for job in ('b','c'):docker.add('nocheh-box-'+job*24,launcher.box_labels(box(job=job*64)))
        listed={key(box(job=job*64)):box()['expires'] for job in 'abcd'}
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.object(launcher,'live_boxes',return_value=listed),patch.dict(os.environ,ENV):
            with self.assertRaisesRegex(ValueError,'job_box_limit'):launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
            launcher.prepare_box(box(),'step.credential',lambda:False,3,later())
            docker.image='nocheh-box:local'
            with self.assertRaisesRegex(ValueError,'pinned_box_image_required'):launcher.prepare_box(box(job='d'*64),'step.credential',lambda:False,8,later())
            with self.assertRaisesRegex(ValueError,'job_box_expired'):launcher.prepare_box(box(job='d'*64,expires='2000-01-01T00:00:00Z'),'step.credential',lambda:False,8,later())
            with patch.dict(os.environ,{'NOCHEH_BOX_TOKEN':'t'*31}),self.assertRaisesRegex(ValueError,'box_token_required'):
                launcher.prepare_box(box(job='d'*64),'step.credential',lambda:False,8,later())
        self.assertEqual(len(docker.containers),3);self.assertFalse(any(v.startswith('nocheh-box-') and v not in docker.names() for v in docker.volumes))

    def test_boxes_the_sweep_would_remove_hold_no_slot(self):
        docker=FakeDocker();chat=Chat({None:page([])});asked=[]
        docker.add('nocheh-box-'+'b'*24,launcher.box_labels(box(job='b'*64)))
        # The job stopped running, so /v1/box/live no longer lists it; and a box past its expiry.
        docker.add('nocheh-box-'+'c'*24,launcher.box_labels(box(job='c'*64)))
        docker.add('nocheh-box-'+'d'*24,launcher.box_labels(box(job='d'*64,expires='2000-01-01T00:00:00Z')))
        listed={key(entry):entry['expires'] for entry in (box(),box(job='b'*64),box(job='d'*64),box(job='e'*64))}
        def live_boxes(timeout=10):
            asked.append(timeout)
            if isinstance(listed,Exception):raise listed
            return listed
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.object(launcher,'live_boxes',live_boxes),patch.dict(os.environ,ENV):
            identifier,name=launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
            self.assertEqual(docker.names(),sorted(['nocheh-box-'+'b'*24,name]))
            self.assertEqual(sorted(docker.volumes),sorted(['nocheh-box-'+'b'*24,name]))
            self.assertEqual(len(asked),1);self.assertLessEqual(asked[0],10)
            # Listed boxes do hold their slots.
            with self.assertRaisesRegex(ValueError,'job_box_limit'):launcher.prepare_box(box(job='e'*64),'step.credential',lambda:False,2,later())
            self.assertEqual(len(asked),2)
            # Below the limit the live list is not asked.
            launcher.prepare_box(box(job='e'*64),'step.credential',lambda:False,3,later());self.assertEqual(len(asked),2)
            # While /live does not answer, only expiry frees a slot.
            listed=OSError('security_unavailable')
            with self.assertRaisesRegex(ValueError,'job_box_limit'):launcher.prepare_box(box(job='f'*64),'step.credential',lambda:False,3,later())
        self.assertEqual(len(docker.containers),3)

    def test_sweep_keeps_only_listed_unexpired_running_boxes(self):
        docker=FakeDocker()
        kept=docker.add('nocheh-box-'+'1'*24,launcher.box_labels(box()))
        docker.add('nocheh-box-'+'2'*24,launcher.box_labels(box(job='b'*64,valid_from_epoch=4)))
        docker.add('nocheh-box-'+'3'*24,launcher.box_labels(box(job='c'*64,expires='2000-01-01T00:00:00Z')))
        docker.add('nocheh-box-'+'4'*24,launcher.box_labels(box(job='e'*64)),state='exited')
        docker.add('unrelated-box',launcher.box_labels(box(job='f'*64)))
        docker.volumes['nocheh-box-'+'5'*24]={'Name':'nocheh-box-'+'5'*24,'Labels':{'nocheh.role':'job-box','nocheh.box.network':'nocheh-agent'}}
        docker.volumes['nocheh-box-'+'6'*24]={'Name':'nocheh-box-'+'6'*24,'Labels':{}}
        live={key(b):b['expires'] for b in (box(),box(job='b'*64,valid_from_epoch=5),box(job='c'*64),box(job='e'*64))}
        launcher.BOXES[kept]={}
        with patch.object(launcher,'docker',docker):
            launcher.sweep(lambda:None)
            self.assertEqual(docker.names(),['nocheh-box-'+'1'*24,'nocheh-box-'+'2'*24,'unrelated-box'],'only expiry and stopped boxes go while /live is unknown')
            launcher.sweep(lambda:live)
            self.assertEqual(docker.names(),['nocheh-box-'+'1'*24,'unrelated-box'])
            self.assertEqual(sorted(docker.volumes),['nocheh-box-'+'1'*24,'nocheh-box-'+'6'*24,'unrelated-box'])
            self.assertIn(kept,launcher.BOXES)
            launcher.sweep(lambda:{})
        self.assertEqual(docker.names(),['unrelated-box'],'only containers with the box label and name are touched')
        self.assertEqual(sorted(docker.volumes),['nocheh-box-'+'6'*24,'unrelated-box'])
        self.assertNotIn(kept,launcher.BOXES)

    def test_a_volume_a_turn_still_mounts_goes_in_a_later_sweep(self):
        docker=FakeDocker();docker.add('nocheh-box-'+'1'*24,launcher.box_labels(box()));docker.in_use.add('nocheh-box-'+'1'*24)
        with patch.object(launcher,'docker',docker):
            launcher.sweep(lambda:{})
            self.assertEqual((docker.names(),list(docker.volumes)),([],['nocheh-box-'+'1'*24]))
            docker.in_use.clear();launcher.sweep(lambda:None)
        self.assertEqual(docker.volumes,{})

    def test_sweeper_removes_every_box_once_live_is_down_for_the_outage(self):
        docker=FakeDocker();docker.add('nocheh-box-'+'1'*24,launcher.box_labels(box()))
        answers=[{key(box()):box()['expires']}];stopped=threading.Event()
        def live_boxes():
            if answers:return answers.pop()
            raise OSError('security_unavailable')
        with patch.object(launcher,'docker',docker),patch.object(launcher,'live_boxes',live_boxes):
            thread=threading.Thread(target=launcher.sweeper,args=(.02,.5,stopped));thread.start()
            try:
                time.sleep(.25);self.assertEqual(len(docker.containers),1,'a short outage keeps boxes')
                for _ in range(100):
                    if not docker.containers:break
                    time.sleep(.02)
            finally:stopped.set();thread.join(2)
        self.assertEqual((docker.containers,docker.volumes),({},{}))

    def test_live_entries_are_checked_and_need_the_box_token(self):
        answer={'boxes':[box(),box(job='bad'),'member: hello']}
        with patch.object(launcher,'security',return_value=answer) as call,patch.dict(os.environ,ENV):
            self.assertEqual(launcher.live_boxes(),{(JOB,'gen-1','on','5'):'2999-01-01T00:00:00.000Z'})
        self.assertEqual(call.call_args.args[:2],('/v1/box/live',{'Authorization':'Bearer '+'t'*40}))
        with patch.dict(os.environ,{'NOCHEH_BOX_TOKEN':''}),self.assertRaises(ValueError):launcher.live_boxes()

    def test_stopping_launcher_removes_turns_then_boxes(self):
        docker=FakeDocker();docker.add('nocheh-box-'+'1'*24,launcher.box_labels(box()))
        docker.containers['turn']={'Id':'turn','Names':['/nocheh-turn-x'],'Labels':{'nocheh.role':'isolated-turn'},'State':'running'}
        with patch.object(launcher,'docker',docker):
            launcher.CONTAINERS.add('turn')
            try:
                with self.assertRaises(SystemExit):launcher.stop()
            finally:launcher.CONTAINERS.clear()
        deletes=[c[1] for c in docker.calls if c[0]=='DELETE']
        self.assertEqual(deletes[0],'/containers/turn?force=true');self.assertEqual(len(deletes),3)
        self.assertEqual((docker.containers,docker.volumes),({},{}))

    def test_boxes_of_another_installation_are_never_touched(self):
        # Another copy of Nocheh on the same Docker (a tester beside the live one): its own network label, even for this job.
        docker=FakeDocker();other={**launcher.box_labels(box()),'nocheh.box.network':'other-agent'}
        theirs=['nocheh-box-'+'a'*24,'nocheh-box-'+'b'*24]
        docker.add(theirs[0],other);docker.add(theirs[1],{**other,'nocheh.box.job':'b'*64})
        chat=Chat({None:page(['1'])})
        def listings():
            return {json.dumps(json.loads(unquote(path.split('filters=')[1]))) for method,path,_ in docker.calls if 'filters=' in path}
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.object(launcher,'live_boxes',return_value={}),patch.dict(os.environ,ENV):
            # Startup, and a sweep whose /v1/box/live lists none of their jobs.
            launcher.sweep(lambda:{});launcher.sweep(lambda:{})
            self.assertEqual(docker.names(),theirs)
            # Their running boxes hold none of this launcher's slots, and their box for the same job is not this one's.
            identifier,name=launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
            self.assertEqual(docker.names(),sorted([*theirs,name]))
            self.assertEqual(docker.containers[identifier]['Labels']['nocheh.box.network'],'nocheh-agent')
            self.assertEqual(docker.volumes[name]['Labels'],{'nocheh.role':'job-box','nocheh.box.network':'nocheh-agent','nocheh.box.job':JOB})
            # Stopping removes only this installation's box.
            with self.assertRaises(SystemExit):launcher.stop()
            self.assertEqual((docker.names(),sorted(docker.volumes)),(theirs,theirs))
            # Docker itself is asked for this installation's boxes only.
            self.assertEqual(listings(),{json.dumps({'label':['nocheh.role=job-box','nocheh.box.network=nocheh-agent']})})
            # The other installation's launcher, in turn, removes its own boxes.
            with patch.dict(os.environ,{'NOCHEH_AGENT_NETWORK':'other-agent'}):launcher.sweep(lambda:{})
        self.assertEqual((docker.containers,docker.volumes),({},{}))

    def test_a_box_made_under_another_network_carries_its_label(self):
        # A tester copy runs with NOCHEH_AGENT_NETWORK=<project>-agent: its boxes are its own, and the live launcher leaves them.
        docker=FakeDocker();chat=Chat({None:page(['1'])})
        with patch.object(launcher,'docker',docker),patch.object(launcher,'security',chat.security),patch.object(launcher,'put',chat.put),\
                patch.dict(os.environ,{**ENV,'NOCHEH_AGENT_NETWORK':'tester-agent'}):
            identifier,name=launcher.prepare_box(box(),'step.credential',lambda:False,2,later())
        self.assertEqual(docker.containers[identifier]['Labels']['nocheh.box.network'],'tester-agent')
        self.assertEqual(docker.volumes[name]['Labels'],{'nocheh.role':'job-box','nocheh.box.network':'tester-agent','nocheh.box.job':JOB})
        with patch.object(launcher,'docker',docker):
            launcher.sweep(lambda:{})
            self.assertEqual((docker.names(),list(docker.volumes)),([name],[name]))
            with patch.dict(os.environ,{'NOCHEH_AGENT_NETWORK':'tester-agent'}):launcher.sweep(lambda:{})
        self.assertEqual((docker.containers,docker.volumes),({},{}))

class ExecDocker:
    """The Docker side of one put: exec create and inspect, and a connection that answers the exec start
    with 101, reads stdin to its end, then sends the given output frames."""
    def __init__(self,frames=(),code=0,running=0):
        self.frames=frames;self.code=code;self.calls=[];self.request=b'';self.stdin=b'';self.running=time.monotonic()+running
    def __call__(self,method,path,body=None):
        self.calls.append((method,path,body))
        if (method,path)==('POST','/containers/box/exec'):return {'Id':'exec-1'}
        # The exec stays running for `running` seconds after the put began, and has no exit code until then.
        if (method,path)==('GET','/exec/exec-1/json'):return {'Running':True,'ExitCode':None} if time.monotonic()<self.running else {'Running':False,'ExitCode':self.code}
        raise AssertionError((method,path))
    def connection(self):
        fake=self
        class Connection(launcher.DockerConnection):
            def connect(self):
                self.sock,other=socket.socketpair();self.sock.settimeout(self.timeout)
                threading.Thread(target=fake.serve,args=(other,),daemon=True).start()
        return Connection
    def serve(self,other):
        with other:
            while b'\r\n\r\n' not in self.request:self.request+=other.recv(1)
            length=int(re.search(rb'Content-Length: (\d+)',self.request).group(1))
            while len(self.request.split(b'\r\n\r\n',1)[1])<length:self.request+=other.recv(length)
            other.sendall(b'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
            while chunk:=other.recv(65536):self.stdin+=chunk
            for frame in self.frames:other.sendall(frame)

def frame(kind,data):return bytes([kind,0,0,0])+len(data).to_bytes(4,'big')+data

class BoxPutExecTests(unittest.TestCase):
    def put(self,docker,name='part-00001.jsonl',data=b'{"text":"member: hello"}\n'*1000,until=None):
        with patch.object(launcher,'docker',docker),patch.object(launcher,'DockerConnection',docker.connection()):
            launcher.put('box',name,data,until or later(5))

    def test_box_put_runs_as_the_chat_owner_with_the_bytes_only_on_stdin(self):
        docker=ExecDocker(frames=[frame(2,b'')]);data=b'{"text":"member: hello"}\n'*1000
        self.put(docker,data=data)
        self.assertEqual(docker.calls[0],('POST','/containers/box/exec',{'User':'65533:65533','WorkingDir':'/','Env':[],
            'Cmd':['python3','-I','/opt/box/box_put.py','part-00001.jsonl',str(len(data)),hashlib.sha256(data).hexdigest()],
            'AttachStdin':True,'AttachStdout':True,'AttachStderr':True,'Tty':False}))
        self.assertNotIn('member',json.dumps(docker.calls))
        head,body=docker.request.split(b'\r\n\r\n',1)
        self.assertTrue(head.startswith(b'POST /v1.41/exec/exec-1/start HTTP/1.1'));self.assertIn(b'Upgrade: tcp',head)
        self.assertEqual(json.loads(body),{'Detach':False,'Tty':False})
        # box_put sees the end of stdin only because the launcher half-closes the connection.
        self.assertEqual(docker.stdin,data)

    def test_a_write_box_put_refused_or_too_much_output_fails_the_put(self):
        with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):self.put(ExecDocker(code=3))
        # box_put's FULL: no room in /chat, which ends this box's copy for good.
        with self.assertRaisesRegex(RuntimeError,'box_chat_full'):self.put(ExecDocker(code=4))
        with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):self.put(ExecDocker(frames=[frame(2,b'x'*(64*1024+1))]))
        with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):self.put(ExecDocker(frames=[b'\x03\0\0\0\0\0\0\x01x']))
        docker=ExecDocker()
        with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):self.put(docker,until=time.monotonic()-1)
        self.assertEqual(docker.calls,[],'nothing starts after the deadline')

    def test_box_put_waits_for_its_exec_to_end_only_until_the_deadline(self):
        docker=ExecDocker(frames=[frame(2,b'')],running=.2);self.put(docker,until=later(5))
        self.assertGreater(docker.calls.count(('GET','/exec/exec-1/json',None)),1,'a put waits for box_put to exit')
        # An exec still running at the deadline fails the put, so a stuck write never holds the job and its turn slot.
        docker=ExecDocker(frames=[frame(2,b'')],running=3);began=time.monotonic()
        with self.assertRaisesRegex(RuntimeError,'box_fill_failed'):self.put(docker,until=began+.3)
        self.assertLess(time.monotonic()-began,1.5)

class WaitDocker(ExecDocker):
    """The Docker side of a turn's exit wait: the headers once the wait is set, the body once the turn exited."""
    def __init__(self,status=200,code=0):self.status=status;self.code=code;self.request=b'';self.exited=threading.Event()
    def serve(self,other):
        with other:
            while b'\r\n\r\n' not in self.request:self.request+=other.recv(1)
            if self.status!=200:other.sendall(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');return
            other.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n')
            self.exited.wait(5);body=json.dumps({'Error':None,'StatusCode':self.code}).encode()
            other.sendall(b'%x\r\n%s\r\n0\r\n\r\n'%(len(body),body))

class ExitCodeTests(unittest.TestCase):
    def test_a_turns_exit_code_comes_from_a_wait_set_before_it_starts(self):
        docker=WaitDocker(code=137)
        with patch.object(launcher,'DockerConnection',docker.connection()):
            # Docker answered the headers while the turn was still running: the wait is set.
            code=launcher.exit_code('turn-1')
            self.assertTrue(docker.request.startswith(b'POST /v1.41/containers/turn-1/wait?condition=next-exit HTTP/1.1\r\n'))
            docker.exited.set();self.assertEqual(code(),137)
        # A wait Docker refused gives no exit code, which counts as an abnormal end.
        refused=WaitDocker(status=404)
        with patch.object(launcher,'DockerConnection',refused.connection()):self.assertIsNone(launcher.exit_code('turn-2')())

class HandlerTests(unittest.TestCase):
    """The launcher's /v1/turn with a box binding, against fake Docker and a fake nocheh-security."""
    PROFILE='nocheh-'+'a'*24;IMAGE='sha256:'+'b'*64;BOX='nocheh-box-'+'c'*24
    def setUp(self):
        self.security=Security();self.addCleanup(self.security.close)
        self.docker=FakeDocker();self.prepared=[];self.checked=[];self.attached=[];self.release=threading.Event();self.release.set()
        self.order=[];self.code=0;launcher.ABNORMAL.clear();self.addCleanup(launcher.ABNORMAL.clear)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),launcher.Handler)
        self.server.image=self.IMAGE;self.server.network='nocheh-agent';self.server.host_profiles='/owned/profiles';self.server.box_limit=2
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        def attach(identifier,body):
            credential=body['archive_credential'];self.attached.append(credential);self.order.append('attach')
            if credential=='first':self.release.wait(5)
            if credential=='dropped':
                # Docker ends the stream once the launcher's watch killed the turn.
                for _ in range(500):
                    if self.docker.killed:return
                    time.sleep(.01)
                return
            # A step that reports a failure, one that ends with no result, and a result split across Docker's frames.
            outputs={'failed':[b'{"event":"heartbeat"}\n',b'{"state":"failed","error_code":"model_unavailable"}\n'],'silent':[b'{"event":"heartbeat"}\n'],
                     'split':[b'{"event":"heartbeat"}\n{"sta',b'te":"done","text":"Report: done"}',b'\n'],
                     'framed':[b'{"event":"heartbeat"}\n',b'{"state":"done","text":"Report: done"}\n']}
            yield from outputs.get(credential,[b'{"state":"done"}\n'])
            if credential=='broken':raise RuntimeError('container_output_limit')
        def exit_code(identifier):self.order.append('wait');return lambda:self.code
        def prepare_box(entry,credential,gone,limit,until):
            self.prepared.append((entry,credential,limit,until-time.monotonic(),until))
            if isinstance(self.box,Exception):raise self.box
            return self.box
        def running(identifier):self.checked.append((identifier,launcher.BOX_LOCK.locked()));return self.running
        self.box=('box-id',self.BOX);self.running=True
        for name,value in (('docker',self.docker),('attach',attach),('prepare_box',prepare_box),('running',running),('exit_code',exit_code),
                           ('validate_local_profile',lambda profile:None)):
            patcher=patch.object(launcher,name,value);patcher.start();self.addCleanup(patcher.stop)
        environment=patch.dict(os.environ,{'SERVICE_TOKEN':'s'*32,'NOCHEH_UID':'1000','NOCHEH_GID':'1000','NOCHEH_SECURITY_URL':self.security.url()})
        environment.start();self.addCleanup(environment.stop);os.environ.pop('NOCHEH_DEV_TURN_SOURCE',None)

    def bind(self,credential,profile=None,entry=None):
        self.security.bindings[credential]={'profile':profile or self.PROFILE,'model':'model-1','owner':'owner-1','scope':'chat-1',
                                            'model_context_length':1000,'box':entry}

    def body(self,credential):
        return json.dumps({'archive_credential':credential,'model':'model-1','owner':'owner-1','chat_id':'chat-1','api_mode':'chat_completions'}).encode()

    def turn(self,credential,results=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=10)
        connection.request('POST','/v1/turn',body=self.body(credential),headers={'Authorization':'Bearer '+'s'*32,'Content-Type':'application/json'})
        response=connection.getresponse();result=(response.status,response.read());connection.close()
        if results is not None:results.append(result)
        return result

    def drop(self,credential):
        """A turn whose client goes away, as a killed bridge does: it stops sending and the launcher sees its end."""
        body=self.body(credential)
        with socket.create_connection(('127.0.0.1',self.server.server_address[1]),timeout=10) as client:
            client.sendall(b'POST /v1/turn HTTP/1.1\r\nHost: launcher\r\nAuthorization: Bearer '+b's'*32+
                           b'\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n'%len(body)+body)
            client.shutdown(socket.SHUT_WR)
            while client.recv(65536):pass

    def settled(self):
        # Every turn has ended once each of its slots is free again.
        slots=[launcher.SLOTS.acquire(timeout=5) for _ in range(launcher.parallel('NOCHEH_PARALLEL_RUNS',4))]
        for taken in slots:
            if taken:launcher.SLOTS.release()
        self.assertEqual((launcher.ACTIVE,launcher.BOX_JOBS,launcher.CONTAINERS),(set(),set(),set()))

    def turn_specs(self):return [body for method,path,body in self.docker.calls if path.startswith('/containers/create?name=nocheh-turn-')]

    def plain(self):return launcher.container_spec(self.PROFILE,'/owned/profiles',self.IMAGE,'nocheh-agent',1000,1000)

    def test_a_box_step_mounts_its_prepared_box(self):
        self.bind('first',entry=box())
        self.assertEqual(self.turn('first'),(200,b'{"state":"done"}\n'))
        self.settled()
        self.assertEqual(self.turn_specs(),[launcher.container_spec(self.PROFILE,'/owned/profiles',self.IMAGE,'nocheh-agent',1000,1000,None,self.BOX)])
        (entry,credential,limit,remaining,_),=self.prepared
        self.assertEqual((entry,credential,limit),(box(),'first',2));self.assertTrue(0<remaining<=launcher.FILL_SECONDS)
        self.assertEqual(self.checked,[('box-id',True)],'the box is checked under the box lock, just before the turn is made')

    def test_the_fill_deadline_counts_from_the_request_start(self):
        # The binding fetch may take up to 120 s itself: counted from later, the fill would run past security_client's 235 s.
        self.bind('first',entry=box());self.security.delay=.3;began=time.monotonic()
        self.assertEqual(self.turn('first')[0],200);self.settled()
        (*_,until),=self.prepared;asked,=self.security.asked
        self.assertGreaterEqual(until,began+launcher.FILL_SECONDS);self.assertLessEqual(until,asked+launcher.FILL_SECONDS)

    def test_a_turn_without_its_box_gets_no_box_mount_or_environment(self):
        # The box could not be made, or the sweep removed it meanwhile: the turn itself then stops with job_box_unavailable.
        for failure in ('prepare','running'):
            self.docker.calls.clear();self.box=RuntimeError('job_box_limit') if failure=='prepare' else ('box-id',self.BOX);self.running=failure!='running'
            self.bind('first',entry=box())
            self.assertEqual(self.turn('first')[0],200,failure);self.settled()
            self.assertEqual(self.turn_specs(),[self.plain()],failure)
        # Steps of a job without a box, wrap-up steps and late steps have no box in their binding: no box is touched.
        self.docker.calls.clear();self.prepared.clear();self.bind('first',entry=None)
        self.assertEqual(self.turn('first')[0],200);self.settled()
        self.assertEqual((self.turn_specs(),self.prepared),([self.plain()],[]))
        self.assertFalse([c for c in self.docker.calls if 'job-box' in json.dumps(c) or '/volumes' in c[1]])

    def test_only_a_box_turn_that_ended_by_itself_with_success_keeps_its_box(self):
        # Exit code 0 and no kill: the job's next step may reuse its box, and an earlier mark is cleared.
        launcher.ABNORMAL.add(JOB);self.bind('first',entry=box())
        self.assertEqual(self.turn('first'),(200,b'{"state":"done"}\n'));self.settled()
        self.assertEqual(launcher.ABNORMAL,set())
        self.assertEqual(self.order,['wait','attach'],'the exit wait is set before the turn starts')
        # Killed from outside (out of memory, a stopped launcher), or an exit code that never came.
        for code in (137,None):
            self.code=code;self.assertEqual(self.turn('first')[0],200);self.settled()
            self.assertEqual(launcher.ABNORMAL,{JOB},code);launcher.ABNORMAL.clear()
        self.code=0
        # An error while the turn streams.
        self.bind('broken',entry=box());self.turn('broken');self.settled()
        self.assertEqual(launcher.ABNORMAL,{JOB});launcher.ABNORMAL.clear()
        # The client went away, so the launcher's watch killed the turn (exit code 0 here: the kill alone counts).
        self.bind('dropped',entry=box());self.drop('dropped');self.settled()
        self.assertEqual(len(self.docker.killed),1);self.assertEqual(launcher.ABNORMAL,{JOB});launcher.ABNORMAL.clear()
        # A step that exits by itself with code 0 but reports a failure, or no result at all.
        for credential in ('failed','silent'):
            self.bind(credential,entry=box());self.assertEqual(self.turn(credential)[0],200);self.settled()
            self.assertEqual(launcher.ABNORMAL,{JOB},credential);launcher.ABNORMAL.clear()
        # The result is the output's last line, after the heartbeats and however Docker split it.
        launcher.ABNORMAL.add(JOB);self.bind('split',entry=box())
        self.assertEqual(self.turn('split'),(200,b'{"event":"heartbeat"}\n{"state":"done","text":"Report: done"}\n'));self.settled()
        self.assertEqual(launcher.ABNORMAL,set())
        # The usual long step: a heartbeat in one frame, then the result in the next.
        launcher.ABNORMAL.add(JOB);self.bind('framed',entry=box())
        self.assertEqual(self.turn('framed')[0],200);self.settled()
        self.assertEqual(launcher.ABNORMAL,set())
        # A step that ran without its box leaves no mark, and sets no wait.
        self.running=False;self.code=137;self.order.clear();self.turn('first');self.settled()
        self.assertEqual((launcher.ABNORMAL,self.order),(set(),['attach']))

    def test_the_job_is_released_after_every_turn(self):
        self.bind('first',entry=box());self.turn('first');self.settled()
        # A turn that fails after its job was reserved.
        self.bind('first',entry=box());self.security.bindings['first']['scope']='chat-2'
        self.assertEqual(self.turn('first')[0],503);self.settled()
        self.bind('first',entry=box(job='../x'))
        self.assertEqual(self.turn('first')[0],503);self.settled()

    def test_a_second_turn_of_a_job_with_a_turn_in_flight_is_refused(self):
        self.release.clear();self.bind('first',entry=box());self.bind('second',profile='nocheh-'+'d'*24,entry=box());results=[]
        thread=threading.Thread(target=self.turn,args=('first',results));thread.start()
        try:
            for _ in range(200):
                if self.attached:break
                time.sleep(.01)
            self.assertEqual(self.turn('second')[0],503)
        finally:self.release.set();thread.join(10)
        self.assertEqual(results,[(200,b'{"state":"done"}\n')]);self.assertEqual(self.attached,['first'])
        self.settled()
        self.assertEqual(self.turn('second')[0],200,'the job is free again once its turn ended');self.settled()

class StartupDocker(FakeDocker):
    """What main() asks Docker before serving: the internal network, the turn image, its own mounts."""
    def __init__(self,images):super().__init__();self.images=images
    def __call__(self,method,path,body=None):
        if method=='GET' and path.startswith('/networks/'):self.calls.append((method,path,body));return {'Internal':True}
        if method=='GET' and path.startswith('/images/'):
            self.calls.append((method,path,body))
            if path.split('/')[2] not in self.images:raise RuntimeError('container_operation_failed')
            return {'Id':'sha256:'+'b'*64}
        if method=='GET' and path=='/containers/'+socket.gethostname()+'/json':
            self.calls.append((method,path,body));return {'Mounts':[{'Destination':'/profiles','Type':'bind','RW':False,'Source':'/owned/profiles'}]}
        return super().__call__(method,path,body)

class FakeServer:
    def __init__(self,address,handler):FakeServer.made=self
    def serve_forever(self):pass

class StartupTests(unittest.TestCase):
    def start(self,docker,environment):
        with patch.object(launcher,'docker',docker),patch.object(launcher,'ThreadingHTTPServer',FakeServer),patch.object(launcher,'sweeper',lambda:None),\
                patch.object(launcher.signal,'signal'),patch.dict(os.environ,environment),patch('sys.stderr',new_callable=io.StringIO) as errors:
            launcher.main()
        return errors.getvalue()

    def test_startup_removes_old_boxes_and_says_once_what_stops_every_box(self):
        docker=StartupDocker({'nocheh-hermes:local'});docker.add('nocheh-box-'+'1'*24,launcher.box_labels(box()))
        theirs='nocheh-box-'+'2'*24;docker.add(theirs,{**launcher.box_labels(box()),'nocheh.box.network':'other-agent'})
        said=self.start(docker,{'NOCHEH_BOX_TOKEN':'short-made-up-value','NOCHEH_BOX_IMAGE':'nocheh-box:local'})
        self.assertEqual((docker.names(),list(docker.volumes)),([theirs],[theirs]),'boxes of an earlier launcher are removed, not another installation\'s')
        self.assertEqual(said.count('\n'),1);self.assertIn('NOCHEH_BOX_TOKEN',said);self.assertIn('nocheh-box:local',said)
        self.assertNotIn('short-made-up-value',said)
        self.assertEqual(FakeServer.made.box_limit,2)
        said=self.start(StartupDocker({'nocheh-hermes:local'}),{'NOCHEH_BOX_TOKEN':'t'*40,'NOCHEH_BOX_LIMIT':'8'})
        self.assertEqual(said.count('\n'),1);self.assertNotIn('NOCHEH_BOX_TOKEN',said);self.assertIn('nocheh-box:local',said)
        self.assertEqual(FakeServer.made.box_limit,8)
        self.assertEqual(self.start(StartupDocker({'nocheh-hermes:local','nocheh-box:local'}),{'NOCHEH_BOX_TOKEN':'t'*40}),'')

    def test_startup_refuses_a_box_limit_below_the_jobs_that_run_at_once(self):
        for value in ('1','0','9','two'):
            docker=StartupDocker({'nocheh-hermes:local','nocheh-box:local'})
            with self.assertRaisesRegex(ValueError,'NOCHEH_BOX_LIMIT'):self.start(docker,{'NOCHEH_BOX_TOKEN':'t'*40,'NOCHEH_BOX_LIMIT':value})
            self.assertEqual(docker.calls,[])
        with patch.dict(os.environ,{'NOCHEH_BOX_LIMIT':''}):self.assertEqual(launcher.box_limit(),2)

class BoxPutTests(unittest.TestCase):
    def run_put(self,chat,name,data,sent=None,size=None,digest=None):
        read,write=os.pipe()
        def feed():
            with os.fdopen(write,'wb') as pipe:pipe.write(data if sent is None else sent)
        thread=threading.Thread(target=feed);thread.start();umask=os.umask(0o000)
        # docker exec starts box_put with umask 0000.
        try:return box_put.main([name,str(len(data) if size is None else size),digest or hashlib.sha256(data).hexdigest()],str(chat),read)
        finally:os.umask(umask);thread.join();os.close(read)

    def test_only_complete_exact_pages_are_kept_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            chat=Path(folder);data=b'{"text":"member: hello"}\n'*5000
            self.assertEqual(self.run_put(chat,'part-00001.jsonl',data),0)
            part=chat/'part-00001.jsonl'
            self.assertEqual((part.read_bytes(),stat.S_IMODE(part.stat().st_mode)),(data,0o444))
            # A dropped connection: fewer bytes than promised, or more, or other bytes, are never kept.
            self.assertEqual(self.run_put(chat,'part-00002.jsonl',data,sent=data[:len(data)//2]),3)
            self.assertEqual(self.run_put(chat,'part-00002.jsonl',data,sent=data+b'x'),3)
            self.assertEqual(self.run_put(chat,'part-00002.jsonl',data,digest='0'*64),3)
            self.assertEqual(sorted(p.name for p in chat.iterdir()),['part-00001.jsonl'],'nothing committed and no temporary file left')
            # A part is never replaced: the same part again is kept as it is, other bytes under its name are refused.
            self.assertEqual(self.run_put(chat,'part-00001.jsonl',data),0)
            self.assertEqual(self.run_put(chat,'part-00001.jsonl',b'{"text":"edited"}\n'),3)
            self.assertEqual(self.run_put(chat,'part-00001.jsonl',data+data),3)
            self.assertEqual(part.read_bytes(),data)
            for text in (b'{"complete":false}',b'{"complete":true}'):self.assertEqual(self.run_put(chat,'manifest.json',text),0)
            self.assertEqual((chat/'manifest.json').read_bytes(),b'{"complete":true}')
            self.assertEqual(stat.S_IMODE((chat/'manifest.json').stat().st_mode),0o444)
            for name in ('../part-00001.jsonl','part-1.jsonl','manifest.json.tmp','.hidden'):
                self.assertEqual(self.run_put(chat,name,b'x'),2,name)
            self.assertEqual(sorted(p.name for p in chat.iterdir()),['manifest.json','part-00001.jsonl'])

    def test_no_room_for_a_part_is_full(self):
        def room(free):return patch.object(box_put.os,'statvfs',return_value=SimpleNamespace(f_bavail=free,f_frsize=1))
        with tempfile.TemporaryDirectory() as folder:
            chat=Path(folder);data=b'{"text":"member: hello"}\n'*100
            self.assertEqual(self.run_put(chat,'part-00001.jsonl',data),0)
            # A part must leave room for the manifest that counts it: else nothing is written.
            with room(len(data)+box_put.RESERVE-1):
                self.assertEqual(self.run_put(chat,'part-00002.jsonl',data),box_put.FULL)
                # A part already there with these bytes, written again, needs no room.
                self.assertEqual(self.run_put(chat,'part-00001.jsonl',data),0)
            # The manifest is never refused for room, so the one that says full is always written: it uses the room parts leave.
            with room(0):self.assertEqual(self.run_put(chat,'manifest.json',b'{"complete":false,"full":true}'),0)
            self.assertEqual(sorted(p.name for p in chat.iterdir()),['manifest.json','part-00001.jsonl'])
            # That room holds the largest manifest the launcher writes, in whole 4 KiB tmpfs pages.
            largest=launcher.manifest({'complete':False,'next':'\U0001F600'*4096,'parts':10**5,'records':10**9,'checking':10**9,'full':True})
            self.assertGreaterEqual(box_put.RESERVE,-(-len(largest)//4096)*4096)
            with room(len(data)+box_put.RESERVE):self.assertEqual(self.run_put(chat,'part-00002.jsonl',data),0)
            # No room found while writing (ENOSPC) is full too, and leaves nothing behind.
            real=os.open
            with patch.object(box_put.os,'open',lambda path,flags,mode=0o777:real('/dev/full',os.O_WRONLY|os.O_CLOEXEC)):
                self.assertEqual(self.run_put(chat,'part-00003.jsonl',data),box_put.FULL)
            # Any other write error fails this put only, so a later step tries again.
            for error in (PermissionError(errno.EACCES,'Permission denied'),OSError(errno.EIO,'Input/output error')):
                with self.subTest(error=error),patch.object(box_put.os,'open',side_effect=error),self.assertRaises(type(error)):
                    self.run_put(chat,'part-00003.jsonl',data)
            self.assertEqual(sorted(p.name for p in chat.iterdir()),['manifest.json','part-00001.jsonl','part-00002.jsonl'])

class BoxWiringTests(unittest.TestCase):
    def test_turn_spec_without_box_is_unchanged(self):
        # Digests of the step-2 turn specs, before boxes existed.
        args=('nocheh-'+'a'*24,'/owned/profiles','sha256:'+'b'*64,'nocheh-agent',1000,1000)
        for extra,expected in (((),'52622b6067227934a25bed7f20afeebe927db7e4ed1b7d74b55437fb7debea44'),
                               (('/owned/checkout',),'4b9b9be529be20218f4e4a94dd93e4c731aa2f00f3fb5a15b6cd8ad5fa6dec5d')):
            spec=launcher.container_spec(*args,*extra)
            self.assertEqual(hashlib.sha256(json.dumps(spec).encode()).hexdigest(),expected)
            self.assertEqual(launcher.container_spec(*args,*extra,None),spec)
        plain=launcher.container_spec(*args);boxed=launcher.container_spec(*args,None,'nocheh-box-'+'c'*24)
        self.assertEqual(boxed['HostConfig']['Mounts'],plain['HostConfig']['Mounts']+[{'Type':'volume','Source':'nocheh-box-'+'c'*24,'Target':'/box','ReadOnly':True}])
        self.assertEqual(boxed['Env'],plain['Env']+['TERMINAL_ENV=nocheh_box','TERMINAL_CWD=/work','NOCHEH_BOX_SOCKET=/box/exec.sock'])
        self.assertEqual({k:v for k,v in boxed.items() if k not in ('Env','HostConfig')},{k:v for k,v in plain.items() if k not in ('Env','HostConfig')})
        with self.assertRaises(ValueError):launcher.container_spec(*args,None,'../docker.sock')

    def test_box_token_reaches_only_the_broker_and_launcher(self):
        import yaml
        from tools.operations.installation.configuration import ROOT,DEFAULTS
        from tools.operations.installation.settings import EDITABLE
        from tools.operations.provider.monitoring import internal_keys
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())
        self.assertNotIn('NOCHEH_BOX_TOKEN',compose['x-service']['environment'])
        holders={name for name,service in compose['services'].items() if 'NOCHEH_BOX_TOKEN' in (service.get('environment') or {})}
        self.assertEqual(holders,{'nocheh-security','hermes-agent-sb'})
        # Unset, the broker and launcher refuse every box route; an older .env still starts.
        self.assertEqual({compose['services'][name]['environment']['NOCHEH_BOX_TOKEN'] for name in holders},{'${NOCHEH_BOX_TOKEN:-}'})
        launcher_env=compose['services']['hermes-agent-sb']['environment']
        self.assertEqual((launcher_env['NOCHEH_BOX_IMAGE'],launcher_env['NOCHEH_BOX_LIMIT']),('${NOCHEH_BOX_IMAGE:-nocheh-box:local}','${NOCHEH_BOX_LIMIT:-2}'))
        self.assertEqual(compose['services']['nocheh-security']['environment']['SERVICE_TOKEN'],compose['x-service']['environment']['SERVICE_TOKEN'])
        # Settings lists DEFAULTS; the token is generated, never shown or edited there. Monitoring says only whether it is set.
        self.assertNotIn('NOCHEH_BOX_TOKEN',DEFAULTS);self.assertNotIn('NOCHEH_BOX_TOKEN',EDITABLE)
        rows={row['name']:row for row in internal_keys({'NOCHEH_BOX_TOKEN':'t'*40})}
        self.assertEqual((rows['NOCHEH_BOX_TOKEN']['service'],rows['NOCHEH_BOX_TOKEN']['present']),('Sealed job box',True))
        self.assertNotIn('t'*40,json.dumps(rows));self.assertFalse({row['name']:row for row in internal_keys({})}['NOCHEH_BOX_TOKEN']['present'])

    def test_the_box_image_keeps_none_of_its_base_images_variables(self):
        # Docker exec adds the image's variables to box_put and every box command; only a real build shows them,
        # so this pins the flattening that leaves the box the launcher's variables alone, and the setuid sweep.
        from tools.operations.installation.configuration import ROOT
        text=(ROOT/'deploy/box.Dockerfile').read_text();final=text.rsplit('\nFROM ',1)[1]
        self.assertEqual(final.splitlines()[:2],['scratch','COPY --from=box / /']);self.assertNotRegex(text,r'(?m)^\s*ENV\b')
        self.assertIn('test -z "$(find / -xdev -type f -perm /6000)"',text)

    def test_installer_generates_a_separate_box_token(self):
        from tools.operations.installation.configuration import initialize,validate
        from tools.operations.installation.configuration import env_path,read_env,write_env
        with tempfile.TemporaryDirectory() as folder:
            # An existing .env from before boxes gets its token from the next init or up.
            state=Path(folder);write_env(env_path(state),{'NOCHEH_CONFIG_VERSION':'1','NOCHEH_HONCHO_ENABLED':'false'})
            values=initialize(state);token=values['NOCHEH_BOX_TOKEN']
            self.assertGreaterEqual(len(token),32);self.assertNotEqual(token,values['SERVICE_TOKEN'])
            self.assertEqual(initialize(state)['NOCHEH_BOX_TOKEN'],token)
            self.assertEqual(read_env(env_path(state))['NOCHEH_BOX_TOKEN'],token)
            for bad in ({'NOCHEH_BOX_TOKEN':'t'*31},{'NOCHEH_BOX_TOKEN':values['SERVICE_TOKEN']},{'NOCHEH_BOX_LIMIT':'0'},{'NOCHEH_BOX_LIMIT':'1'},{'NOCHEH_BOX_LIMIT':'9'}):
                with self.assertRaises(ValueError,msg=bad):validate({**values,**bad})
            for good in ('2','8'):validate({**values,'NOCHEH_BOX_LIMIT':good})
            # Empty is unset, as in Compose: no job gets a box until init, up or make dev fills it.
            validate({**values,'NOCHEH_BOX_TOKEN':''})

    def test_make_dev_gives_an_operating_env_from_before_boxes_its_token(self):
        import tools.cli.main as cli
        from tools.operations.installation.configuration import DEFAULTS,generate,read_env,write_env
        before=generate({**DEFAULTS,'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'123456789','TELEGRAM_BOT_TOKEN':'made-up-bot-token',
                         'NOCHEH_HONCHO_DATABASE_VOLUME':'made-up_honcho_database','NOCHEH_HONCHO_REDIS_VOLUME':'made-up_honcho_redis'})
        del before['NOCHEH_BOX_TOKEN']
        with tempfile.TemporaryDirectory() as folder,patch('tools.development.live_dev.operating_root',return_value=Path(folder)/'main'):
            root=Path(folder)/'main';root.mkdir();path=root/'.env'
            # make dev reads the operating .env as it is; one from before boxes, or with the token left empty, gets one.
            for saved in (before,{**before,'NOCHEH_BOX_TOKEN':''}):
                write_env(path,saved);cli.development_box_token();values=read_env(path);token=values.pop('NOCHEH_BOX_TOKEN')
                self.assertEqual(values,before);self.assertRegex(token,r'^[0-9a-f]{64}$')
            written=path.read_bytes(),path.stat().st_ino;cli.development_box_token()
            self.assertEqual((path.read_bytes(),path.stat().st_ino),written,'an .env with its token is left as it is')
            # A configuration make dev refuses is never written: here a symlinked .env.
            write_env(root/'target.env',before);path.unlink();path.symlink_to(root/'target.env')
            with self.assertRaisesRegex(ValueError,'symlink'):cli.development_box_token()
            self.assertNotIn('NOCHEH_BOX_TOKEN',read_env(root/'target.env'));self.assertTrue(path.is_symlink())

    def test_up_build_and_dev_build_the_box_image(self):
        import tools.cli.main as cli
        box_build=['docker','build','-f',str(cli.INSTALLATION_ROOT/'deploy/box.Dockerfile'),'-t','nocheh-box:local',str(cli.INSTALLATION_ROOT)]
        def run(command,code=0):
            calls=[]
            with patch.object(sys,'argv',['nocheh',command]),patch.object(cli,'bootstrap'),patch.object(cli,'compose_environment',return_value={'NOCHEH_HONCHO_ENABLED':'false'}),\
                    patch.object(cli,'compose_command',return_value=['docker','compose']),patch('tools.acceptance.subscription.setup.checkout'),\
                    patch('tools.development.live_dev.main',side_effect=lambda *args:calls.append(['live_dev',*args]) or 0),\
                    patch.object(cli,'development_box_token',side_effect=lambda:calls.append(['box_token'])),\
                    patch.object(cli.subprocess,'call',side_effect=lambda arguments,**_:calls.append(arguments) or (code if arguments[:2]==['docker','build'] else 0)):
                return cli.main(),calls
        # The launcher looks for its image as it starts, so up builds the box image before the stack.
        self.assertEqual(run('up'),(0,[box_build,['docker','compose','up','-d','--build','--wait','--wait-timeout','180'],
            ['docker','build','-f',str(cli.INSTALLATION_ROOT/'deploy/tools.Dockerfile'),'-t','nocheh-tools:local',str(cli.INSTALLATION_ROOT)]]))
        self.assertEqual(run('up',code=1),(1,[box_build]),'a box image that does not build stops up before the stack starts')
        self.assertEqual(run('build'),(0,[['docker','compose','build'],box_build]))
        self.assertEqual(run('dev'),(0,[['box_token'],box_build,['live_dev','dev',[]]]))
        self.assertEqual(run('dev',code=1),(1,[['box_token'],box_build]),'a box image that does not build stops make dev')
        self.assertEqual(run('dev-stop'),(0,[['live_dev','dev-stop',[]]]))

if __name__=='__main__':unittest.main()
