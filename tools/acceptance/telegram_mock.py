"""Fixture-only HTTP Bot API subset, with real PTB parsing and durable queue state.

Contract: https://core.telegram.org/bots/api#getupdates, #sendmessage and #getfile.
Unknown methods are recorded and rejected; this is not a Telegram implementation.
"""
import asyncio
import base64
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs

TOKEN='123456:synthetic'
BOT={'id':123456,'is_bot':True,'first_name':'Synthetic','username':'synthetic_fixture_bot',
     'can_join_groups':True,'can_read_all_group_messages':True,'supports_inline_queries':False}


class TelegramMock:
    def __init__(self,state):
        if os.environ.get('NOCHEH_INSTALLATION_FIXTURE')!='1':raise ValueError('explicit_fixture_required')
        self.path=Path(state);self.changed=asyncio.Event()
        self.state=json.loads(self.path.read_text()) if self.path.exists() else {
            'updates':[],'sent':[],'calls':[],'unknown':[],'faults':[],'files':{},'allowed_updates':[],
            'next_message_id':1000,'offset':0}

    def save(self):
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        temporary=self.path.with_suffix('.tmp')
        with temporary.open('w') as file:
            temporary.chmod(0o600);json.dump(self.state,file,ensure_ascii=False);file.flush();os.fsync(file.fileno())
        temporary.replace(self.path)
        directory=os.open(self.path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)

    def inject(self,body):
        updates=body.get('updates',[])
        if not isinstance(updates,list) or len(updates)>100:raise ValueError('invalid_fixture_updates')
        known={item['update_id']:item for item in self.state['updates']}
        for item in updates:
            if not isinstance(item,dict) or type(item.get('update_id')) is not int or item['update_id']<0:raise ValueError('invalid_fixture_update')
            if item['update_id'] in known and known[item['update_id']]!=item:raise ValueError('fixture_update_conflict')
            known[item['update_id']]=item
        if len(known)>1000:raise ValueError('fixture_queue_limit')
        self.state['updates']=sorted(known.values(),key=lambda item:item['update_id'])
        self.save();self.changed.set();return {'queued':len(self.state['updates'])}

    def configure(self,body):
        """Bounded synthetic files/faults; reject malformed control atomically."""
        if not isinstance(body,dict) or set(body)-{'files','faults'}:raise ValueError('invalid_fixture_control')
        files=dict(self.state['files']);faults=list(self.state['faults'])
        for row in body.get('files',[]):
            if (not isinstance(row,dict) or set(row)!={'file_id','file_unique_id','file_path','file_size','bytes_base64'}
                    or not isinstance(row['file_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',row['file_id'])
                    or not isinstance(row['file_path'],str) or not re.fullmatch(r'documents/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',row['file_path'])
                    or not isinstance(row['file_unique_id'],str) or not row['file_unique_id']):raise ValueError('invalid_fixture_file')
            raw=base64.b64decode(row['bytes_base64'],validate=True)
            if type(row['file_size']) is not int or len(raw)!=row['file_size'] or len(raw)>1024*1024:raise ValueError('invalid_fixture_file')
            if row['file_id'] in files and files[row['file_id']]!=row:raise ValueError('fixture_file_conflict')
            files[row['file_id']]=row
        for row in body.get('faults',[]):
            if (not isinstance(row,dict) or set(row)-{'method','code','description','parameters'}
                    or row.get('method') not in ('sendMessage','getFile','getUpdates')
                    or type(row.get('code')) is not int or not 400<=row['code']<=599
                    or not isinstance(row.get('description'),str) or len(row['description'])>200):raise ValueError('invalid_fixture_fault')
            parameters=row.get('parameters',{})
            if not isinstance(parameters,dict) or set(parameters)-{'retry_after'}:raise ValueError('invalid_fixture_fault')
            if row['code']==429:
                delay=parameters.get('retry_after')
                if type(delay) is not int or not 0<=delay<=10:raise ValueError('invalid_fixture_fault')
            elif parameters:raise ValueError('invalid_fixture_fault')
            faults.append(row)
        if len(files)>100 or len(faults)>20:raise ValueError('fixture_control_limit')
        self.state.update(files=files,faults=faults);self.save()
        return {'files':len(files),'faults':len(faults)}

    @staticmethod
    def error(code,description,**extra):return code,{'ok':False,'error_code':code,'description':description,**extra}

    async def call(self,method,data):
        # Operational polling metadata is bounded; confirmed send receipts persist.
        trace={'method':method,'parameters':data,'at':time.time()}
        self.state['calls']=(self.state['calls']+[trace])[-2000:]
        fault=next((item for item in self.state['faults'] if item['method']==method),None)
        if fault:
            trace['status']=fault['code']
            self.state['faults'].remove(fault);self.save()
            return self.error(fault['code'],fault['description'],**({'parameters':fault['parameters']} if 'parameters' in fault else {}))
        if method=='getMe':result=BOT
        elif method=='getWebhookInfo':
            # https://core.telegram.org/bots/api#getwebhookinfo: a long-polling
            # bot has an empty webhook URL; the queued count is still observable.
            result={'url':'','has_custom_certificate':False,'pending_update_count':len(self.state['updates'])}
        elif method=='deleteWebhook':
            if data.get('drop_pending_updates') in (True,'true'):
                self.state['updates']=[]
            result=True
        elif method=='getUpdates':
            offset=int(data.get('offset',0));limit=int(data.get('limit',100));timeout=float(data.get('timeout',0))
            if not 1<=limit<=100 or not 0<=timeout<=60:return self.error(400,'Bad Request: invalid polling parameters')
            if offset<0:self.state['updates']=self.state['updates'][offset:]
            else:self.state['updates']=[item for item in self.state['updates'] if item['update_id']>=offset]
            self.state['offset']=offset
            if 'allowed_updates' in data:
                allowed=data['allowed_updates'];allowed=json.loads(allowed) if isinstance(allowed,str) else allowed
                if not isinstance(allowed,list) or any(not isinstance(item,str) for item in allowed):return self.error(400,'Bad Request: invalid allowed_updates')
                self.state['allowed_updates']=allowed
            self.save();deadline=time.monotonic()+timeout
            while True:
                allowed=self.state['allowed_updates']
                result=[item for item in self.state['updates'] if any(key in item for key in allowed)
                    or not allowed and not any(key in item for key in ('chat_member','message_reaction','message_reaction_count'))][:limit]
                if result or time.monotonic()>=deadline:break
                self.changed.clear()
                try:await asyncio.wait_for(self.changed.wait(),deadline-time.monotonic())
                except asyncio.TimeoutError:break
        elif method=='sendMessage':
            text=data.get('text');chat=data.get('chat_id');topic=data.get('message_thread_id')
            if not isinstance(text,str) or chat is None:return self.error(400,'Bad Request: invalid message')
            if data.get('parse_mode'):
                # Telegram returns parsed Message.text, not escaped request text.
                # This fixture models escaped plain MarkdownV2. Rich markup is
                # explicitly unmodeled and cannot silently pass the rehearsal.
                parsed=[];index=0;unmodeled=data['parse_mode']!='MarkdownV2'
                while not unmodeled and index<len(text):
                    char=text[index]
                    if char=='\\' and index+1<len(text) and 1<=ord(text[index+1])<=126:
                        parsed.append(text[index+1]);index+=2;continue
                    if char in '\\_*[]()~`>#+-=|{}.!':unmodeled=True;break
                    parsed.append(char);index+=1
                if unmodeled:
                    self.state['unknown'].append('sendMessage:rich_markup');self.save()
                    return self.error(400,'Bad Request: fixture markup not implemented')
                text=''.join(parsed)
            if not 1<=len(text)<=4096:return self.error(400,'Bad Request: invalid message')
            if topic is not None and int(topic)<=0:return self.error(400,'Bad Request: message thread not found')
            chat=int(chat);self.state['next_message_id']+=1
            result={'message_id':self.state['next_message_id'],'date':int(time.time()),'from':BOT,
                'chat':{'id':chat,'type':'private' if chat>0 else 'supergroup'},'text':text}
            if topic is not None:result.update(message_thread_id=int(topic),is_topic_message=True)
            self.state['sent'].append({'parameters':data,'message':result})
        elif method=='sendChatAction':result=True
        elif method in ('setMyCommands','setChatMenuButton'):result=True
        elif method=='getMyCommands':result=[]
        elif method=='getFile':
            file=self.state['files'].get(data.get('file_id'))
            if file is None:return self.error(400,'Bad Request: invalid file_id')
            result={key:value for key,value in file.items() if key!='bytes_base64'}
        else:
            self.state['unknown'].append(method);self.save()
            return self.error(400,'Bad Request: fixture method not implemented')
        trace['status']=200
        self.save();return 200,{'ok':True,'result':result}

    def install(self,app):
        from fastapi import Request
        from fastapi.responses import JSONResponse,Response

        @app.api_route('/bot{token}/{method}',methods=['GET','POST'])
        async def invoke(token:str,method:str,request:Request):
            if token!=TOKEN:return JSONResponse({'ok':False,'error_code':401,'description':'Unauthorized'},status_code=401)
            raw=await request.body()
            if len(raw)>1024*1024:return JSONResponse({'ok':False,'error_code':413,'description':'Fixture request limit'},status_code=413)
            try:
                data=dict(request.query_params) if request.method=='GET' else json.loads(raw) if 'application/json' in request.headers.get('content-type','') else {key:values[-1] for key,values in parse_qs(raw.decode(),keep_blank_values=True).items()}
                status,body=await self.call(method,data)
            except (TypeError,ValueError):status,body=self.error(400,'Bad Request: malformed parameters')
            return JSONResponse(body,status_code=status)

        @app.get('/file/bot{token}/{file_path:path}')
        async def download(token:str,file_path:str):
            if token!=TOKEN:return Response(status_code=401)
            file=next((row for row in self.state['files'].values() if row['file_path']==file_path),None)
            return Response(base64.b64decode(file['bytes_base64']),media_type='application/octet-stream') if file else Response(status_code=404)

        @app.post('/fixture/telegram')
        async def inject(request:Request):
            try:return self.inject(await request.json())
            except (ValueError,TypeError):return JSONResponse({'error':'invalid_fixture_updates'},status_code=400)

        @app.get('/fixture/telegram')
        async def snapshot():return self.state

        @app.post('/fixture/telegram/control')
        async def configure(request:Request):
            try:return self.configure(await request.json())
            except (ValueError,TypeError,KeyError):return JSONResponse({'error':'invalid_fixture_control'},status_code=400)
