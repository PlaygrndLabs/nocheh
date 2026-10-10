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


MARKERS={'*':'bold','_':'italic','__':'underline','~':'strikethrough','||':'spoiler'}
RESERVED='_*[]()~`>#+-=|{}.!'


def markdown_v2(source):
    """Parse MarkdownV2 like https://core.telegram.org/bots/api#markdownv2-style.

    Returns the plain text and entities, or raises ValueError with Telegram's
    own wording for an unescaped reserved character or an unclosed entity.
    Custom emoji and expandable block quotes are outside this subset.
    """
    text,entities,stack,index=[],[],[],0
    units=lambda:sum(2 if ord(char)>0xFFFF else 1 for char in text)
    offset=lambda position:len(source[:position].encode('utf-8'))
    while index<len(source):
        char=source[index]
        if char=='\\':
            if index+1>=len(source) or not 1<=ord(source[index+1])<=126:
                raise ValueError("Character '\\' is reserved and must be escaped with the preceding '\\'")
            text.append(source[index+1]);index+=2;continue
        if char=='`':
            fence='```' if source.startswith('```',index) else '`'
            start,body,index=units(),[],index+len(fence)
            while not source.startswith(fence,index):
                if index>=len(source):raise ValueError("Can't find end of "+('Pre' if len(fence)==3 else 'Code')+' entity at byte offset '+str(offset(index-len(fence))))
                if source[index]=='\\' and index+1<len(source) and source[index+1] in '`\\':index+=1
                body.append(source[index]);index+=1
            if len(fence)==3 and '\n' in body:
                first=''.join(body).split('\n',1)
                if first[0] and ' ' not in first[0]:body=list(first[1])
            text.extend(body);index+=len(fence)
            entities.append({'type':'pre' if len(fence)==3 else 'code','offset':start,'length':units()-start});continue
        marker=source[index:index+2] if source[index:index+2] in ('__','||') else char
        if marker in MARKERS:
            if stack and stack[-1][0]==marker:
                kind,start,_=stack.pop();entities.append({'type':MARKERS[kind],'offset':start,'length':units()-start})
            elif any(item[0]==marker for item in stack):raise ValueError("Can't find end of "+MARKERS[stack[-1][0]].capitalize()+' entity at byte offset '+str(stack[-1][2]))
            else:stack.append((marker,units(),offset(index)))
            index+=len(marker);continue
        if char=='[':
            stack.append(('[',units(),offset(index)));index+=1;continue
        if char==']' and stack and stack[-1][0]=='[' and source[index+1:index+2]=='(':
            close=source.find(')',index+2)
            if close<0:raise ValueError("Can't find end of a URL at byte offset "+str(offset(index+1)))
            _,start,_=stack.pop();entities.append({'type':'text_link','offset':start,'length':units()-start,'url':source[index+2:close].replace('\\)',')')})
            index=close+1;continue
        if char=='>' and (index==0 or source[index-1]=='\n'):
            # A block quote runs to the end of its line.
            end=source.find('\n',index);end=len(source) if end<0 else end
            quoted,_=markdown_v2(source[index+1:end]);start=units();text.extend(quoted)
            entities.append({'type':'blockquote','offset':start,'length':units()-start});index=end;continue
        if char in RESERVED:raise ValueError("Character '"+char+"' is reserved and must be escaped with the preceding '\\'")
        text.append(char);index+=1
    if stack:
        kind=stack[-1][0];name='TextUrl' if kind=='[' else MARKERS[kind].capitalize()
        raise ValueError("Can't find end of "+name+' entity at byte offset '+str(stack[-1][2]))
    return ''.join(text),sorted((entity for entity in entities if entity['length']>0),key=lambda entity:(entity['offset'],-entity['length']))


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
        titles=self.state.setdefault('titles',{})
        for item in updates:
            chat=(item.get('message') or item.get('edited_message') or {}).get('chat') or {}
            if isinstance(chat.get('title'),str) and type(chat.get('id')) is int:titles[str(chat['id'])]=chat['title']
        self.save();self.changed.set();return {'queued':len(self.state['updates'])}

    def configure(self,body):
        """Bounded synthetic files/faults; reject malformed control atomically."""
        if not isinstance(body,dict) or set(body)-{'files','faults','chats'}:raise ValueError('invalid_fixture_control')
        files=dict(self.state['files']);faults=list(self.state['faults']);chats=dict(self.state.get('chats',{}))
        for row in body.get('chats',[]):
            if (not isinstance(row,dict) or set(row)-{'id','type','title','username','is_forum','migrate_to_chat_id'} or type(row.get('id')) is not int
                    or row.get('type') not in ('group','supergroup','private','channel')):raise ValueError('invalid_fixture_chat')
            chats[str(row['id'])]=row
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
            if not isinstance(parameters,dict) or set(parameters)-{'retry_after','deliver'}:raise ValueError('invalid_fixture_fault')
            if row['code']==429:
                delay=parameters.get('retry_after')
                if type(delay) is not int or not 0<=delay<=10 or 'deliver' in parameters:raise ValueError('invalid_fixture_fault')
            elif 'deliver' in parameters:
                # A lost response: Telegram accepted the message, but the bot
                # observes only a gateway failure and cannot know the outcome.
                if parameters!={'deliver':True} or row['method']!='sendMessage' or row['code']<500:raise ValueError('invalid_fixture_fault')
            elif parameters:raise ValueError('invalid_fixture_fault')
            faults.append(row)
        if len(files)>100 or len(faults)>20:raise ValueError('fixture_control_limit')
        if len(chats)>50:raise ValueError('fixture_control_limit')
        self.state.update(files=files,faults=faults,chats=chats);self.save()
        return {'files':len(files),'faults':len(faults),'chats':len(chats)}

    @staticmethod
    def error(code,description,**extra):return code,{'ok':False,'error_code':code,'description':description,**extra}

    async def call(self,method,data):
        # Operational polling metadata is bounded; confirmed send receipts persist.
        trace={'method':method,'parameters':data,'at':time.time()}
        self.state['calls']=(self.state['calls']+[trace])[-2000:]
        fault=next((item for item in self.state['faults'] if item['method']==method),None)
        if fault and fault.get('parameters',{}).get('deliver'):
            self.state['faults'].remove(fault)
            status,_=await self.call(method,data)
            self.state['calls'].pop()
            trace['status']=fault['code'];trace['delivered']=status==200;self.save()
            return fault['code'],'Bad Gateway'
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
            entities=[]
            if data.get('parse_mode'):
                # Telegram returns parsed Message.text and entities, not the
                # escaped request text. Other parse modes stay unmodeled and
                # cannot silently pass the rehearsal.
                if data['parse_mode']!='MarkdownV2':
                    self.state['unknown'].append('sendMessage:'+str(data['parse_mode']));self.save()
                    return self.error(400,'Bad Request: fixture markup not implemented')
                try:text,entities=markdown_v2(text)
                except ValueError as error:return self.error(400,'Bad Request: can\'t parse entities: '+str(error))
            if not 1<=len(text)<=4096:return self.error(400,'Bad Request: invalid message')
            if topic is not None and int(topic)<=0:return self.error(400,'Bad Request: message thread not found')
            chat=int(chat);self.state['next_message_id']+=1
            # Like Telegram, the sent message carries the chat's current title.
            result={'message_id':self.state['next_message_id'],'date':int(time.time()),'from':BOT,
                'chat':{'id':chat,'type':'private' if chat>0 else 'supergroup',**({'title':self.state.get('titles',{}).get(str(chat))} if self.state.get('titles',{}).get(str(chat)) else {})},'text':text,
                **({'entities':entities} if entities else {})}
            if topic is not None:result.update(message_thread_id=int(topic),is_topic_message=True)
            self.state['sent'].append({'parameters':data,'message':result})
        elif method=='getChat':
            # https://core.telegram.org/bots/api#getchat: presentation for a chat the
            # bot belongs to. The fixture answers from configured synthetic chats.
            chat=self.state.get('chats',{}).get(str(data.get('chat_id')))
            if chat is None:return self.error(400,'Bad Request: chat not found')
            if chat.get('migrate_to_chat_id'):
                return self.error(400,'Bad Request: group chat was upgraded to a supergroup chat',
                    parameters={'migrate_to_chat_id':chat['migrate_to_chat_id']})
            # ChatFullInfo requires these fields; they carry no fixture meaning.
            result={'accent_color_id':0,'max_reaction_count':11,**{key:value for key,value in chat.items() if key in ('id','type','title','username','is_forum')}}
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
            if isinstance(body,str):return Response(body,status_code=status,media_type='text/plain')
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
