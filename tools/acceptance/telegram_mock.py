"""Fixture-only HTTP Bot API subset, with real PTB parsing and durable queue state.

Contract: https://core.telegram.org/bots/api#getupdates, #sendmessage, #getfile,
#editmessagetext, #answercallbackquery, #setmessagereaction, #leavechat, #getchatmember and #setchatmenubutton.
Unknown methods are recorded and rejected; this is not a Telegram implementation.

It also signs Mini App launch data as Telegram does (https://core.telegram.org/bots/webapps#validating-data-for-third-party-use),
with a key pair the tester makes for each fixture in place of Telegram's own (ADR-0265 D2): nocheh-app and
nocheh-miniapp check it with the public half, which they honour only in the fixture.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode

TOKEN='123456:synthetic'
# The bot as other updates show it, and as getMe describes it (https://core.telegram.org/bots/api#user).
BOT_USER={'id':123456,'is_bot':True,'first_name':'Synthetic','username':'synthetic_fixture_bot'}
BOT={**BOT_USER,'can_join_groups':True,'can_read_all_group_messages':True,'supports_inline_queries':False,
     'can_connect_to_business':False,'has_main_web_app':False}
# Telegram's stand-in for a group admin with Remain anonymous on: the `from` of what such an admin does.
ANONYMOUS_ADMIN={'id':1087968824,'is_bot':True,'first_name':'Group','username':'GroupAnonymousBot'}
# Telegram's stand-in for a channel that posts in a group in its own name: the `from` of such a post.
CHANNEL_BOT={'id':136817688,'is_bot':True,'first_name':'Channel','username':'Channel_Bot'}
# https://core.telegram.org/bots/api#chatmemberadministrator: the rights every administrator entry carries.
ADMIN_RIGHTS=('can_manage_chat','can_delete_messages','can_manage_video_chats','can_restrict_members','can_promote_members',
              'can_change_info','can_invite_users','can_post_stories','can_edit_stories','can_delete_stories')


# https://core.telegram.org/bots/api#chatmemberrestricted: what a restricted person may still do, all off here.
RESTRICTED_RIGHTS=('can_send_messages','can_send_audios','can_send_documents','can_send_photos','can_send_videos','can_send_video_notes',
                   'can_send_voice_notes','can_send_polls','can_send_other_messages','can_add_web_page_previews','can_change_info',
                   'can_invite_users','can_pin_messages','can_manage_topics','can_edit_tag','can_react_to_messages')
MEMBER_STATUSES=('creator','administrator','member','restricted','left','kicked')


def chat_member(user,status,is_member=True):
    """A ChatMember of `user`: left, member, administrator or kicked, the statuses a bot's own status takes, or creator,
    or restricted, which is still in the group when `is_member` (https://core.telegram.org/bots/api#chatmember)."""
    if status=='administrator':return {'status':status,'user':user,'can_be_edited':False,'is_anonymous':False,**{right:False for right in ADMIN_RIGHTS}}
    if status=='kicked':return {'status':status,'user':user,'until_date':0}
    if status in ('left','member'):return {'status':status,'user':user}
    if status=='creator':return {'status':status,'user':user,'is_anonymous':False}
    if status=='restricted':return {'status':status,'user':user,'is_member':bool(is_member),'until_date':0,**{right:False for right in RESTRICTED_RIGHTS}}
    raise ValueError('fixture_member_status')


def person_user(user_id):
    """A synthetic Telegram User for a person id, as the tester's messages name their senders."""
    return {'id':int(user_id),'is_bot':False,'first_name':'Synthetic '+str(int(user_id))}


def bot_status(update_id,chat,by,old='left',new='member',date=None):
    """A my_chat_member update (https://core.telegram.org/bots/api#chatmemberupdated): `by`, a User, changed this bot's
    status in `chat` from `old` to `new`. An add is left to member; Telegram reports a leave with the bot itself as `by`."""
    return {'update_id':update_id,'my_chat_member':{'chat':chat,'from':by,'date':int(time.time()) if date is None else date,
            'old_chat_member':chat_member(BOT_USER,old),'new_chat_member':chat_member(BOT_USER,new)}}


def left_member(update_id,chat,user,by=None,date=None):
    """Telegram's service message that `user`, a User, is no longer in the group `chat`
    (https://core.telegram.org/bots/api#message, left_chat_member). Its `from` is who removed them, or the user
    themselves when they left on their own. A bot gets it in privacy mode too. The update id is also the message id."""
    return {'update_id':update_id,'message':{'message_id':update_id,'date':int(time.time()) if date is None else date,'chat':chat,
            'from':by or user,'left_chat_member':user}}


def in_chat_name(update_id,chat,text,sender_chat=None,topic=None,entities=None,date=None):
    """A message posted in a group in a chat's own name (https://core.telegram.org/bots/api#message, sender_chat). With no
    `sender_chat` it is an anonymous admin's: sender_chat is the group itself and `from` is GroupAnonymousBot. Given a
    channel, it is that channel's post: `from` is Channel_Bot. Neither names the person who wrote it. `entities` are the
    text's own, such as a mention of the bot; the update id is also the message id."""
    sender=chat if sender_chat is None else sender_chat
    message={'message_id':update_id,'date':int(time.time()) if date is None else date,'chat':chat,
             'from':ANONYMOUS_ADMIN if sender['id']==chat['id'] else CHANNEL_BOT,'sender_chat':sender,'text':text}
    if entities:message['entities']=entities
    if topic is not None:message.update(message_thread_id=topic,is_topic_message=True)
    return {'update_id':update_id,'message':message}


def press(update_id,message,data,by):
    """A tap on an inline button of `message`, a message the bot sent, as Telegram delivers it (callback_query)."""
    return {'update_id':update_id,'callback_query':{'id':'cb'+str(update_id),'from':by,'chat_instance':'instance-'+str(message['chat']['id']),
            'data':data,'message':message}}


# The fake's private launch key: 64 hex characters, an Ed25519 seed the tester makes for each fixture
# (telegram_rehearsal.py). Only model-fixture, where the fake runs, holds it; nocheh-app and nocheh-miniapp get the public
# half as TELEGRAM_LAUNCH_PUBLIC_KEY.
LAUNCH_KEY_ENV='NOCHEH_TELEGRAM_FIXTURE_LAUNCH_KEY'
# https://core.telegram.org/bots/webapps#webappinitdata: chat_type is absent from the menu button, 'sender' from a link in
# the user's own chat with the bot, and a group's or channel's type from anywhere else.
LAUNCH_CHAT_TYPES=('sender','private','group','supergroup','channel')


def launch_public_key(seed_hex):
    """The public half (64 hex characters) of an Ed25519 launch key given as its 32-byte seed in hex."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    key=Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))
    return key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex()


def new_launch_key():
    """A new launch key seed, in hex."""
    return os.urandom(32).hex()


def launch_data(user,auth_date,seed_hex,bot_id=None,chat_type=None,query_id=None,token=TOKEN):
    """Launch data (Telegram.WebApp.initData) for a Telegram User `user`, signed as Telegram signs it for third parties: an
    Ed25519 signature over "<bot id>:WebAppData\n" and every field but hash and signature as key=value, sorted by key and
    joined by line breaks, in base64url without padding. `hash` is the bot-token HMAC Telegram adds as well
    (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app), over every field but itself. The
    values are percent-encoded as Telegram sends them."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    fields={'auth_date':str(int(auth_date)),'query_id':query_id or 'AAF'+base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip('='),
            'user':json.dumps(user,ensure_ascii=False,separators=(',',':'))}
    if chat_type is not None:
        if chat_type not in LAUNCH_CHAT_TYPES:raise ValueError('invalid_fixture_launch')
        fields['chat_type']=chat_type
        if chat_type!='sender':fields['chat_instance']=str(int.from_bytes(os.urandom(6),'big'))
    signed=str(BOT['id'] if bot_id is None else int(bot_id))+':WebAppData\n'+'\n'.join(key+'='+fields[key] for key in sorted(fields))
    fields['signature']=base64.urlsafe_b64encode(Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex)).sign(signed.encode())).decode().rstrip('=')
    secret=hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
    fields['hash']=hmac.new(secret,'\n'.join(key+'='+fields[key] for key in sorted(fields)).encode(),hashlib.sha256).hexdigest()
    return urlencode(list(fields.items()),quote_via=quote)


# https://core.telegram.org/bots/api#reactiontypeemoji: the only emoji a bot may react with.
REACTIONS=frozenset('👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 '
                    '🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡'.split())

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


def menu_button(text,url):
    """A Web App menu button, as Settings Apply sets one (https://core.telegram.org/bots/api#menubuttonwebapp)."""
    return {'type':'web_app','text':text,'web_app':{'url':url}}


def menu_button_valid(button):
    """A MenuButton Telegram accepts: the default, the command list, or a Web App with a text and an https address
    (https://core.telegram.org/bots/api#menubutton)."""
    if not isinstance(button,dict) or button.get('type') not in ('default','commands','web_app'):return False
    if button['type']!='web_app':return set(button)=={'type'}
    app=button.get('web_app')
    return (set(button)=={'type','text','web_app'} and isinstance(button.get('text'),str) and 1<=len(button['text'])<=64
            and isinstance(app,dict) and set(app)=={'url'} and isinstance(app.get('url'),str) and app['url'].startswith('https://'))


class TelegramMock:
    def __init__(self,state):
        if os.environ.get('NOCHEH_INSTALLATION_FIXTURE')!='1':raise ValueError('explicit_fixture_required')
        self.path=Path(state);self.changed=asyncio.Event()
        self.state=json.loads(self.path.read_text()) if self.path.exists() else {
            'updates':[],'sent':[],'calls':[],'unknown':[],'faults':[],'files':{},'allowed_updates':[],
            'next_message_id':1000,'offset':0,
            # Menus an earlier native Hermes left behind: the default one and a forum group's own.
            'commands':{json.dumps([scope,''],sort_keys=True):[{'command':'status','description':'Show status'}]
                        for scope in ({'type':'default'},{'type':'chat','chat_id':-10042})}}

    def launch(self,body):
        """Launch data for a person, as Telegram would hand it to the Mini App they opened (POST /fixture/telegram/launch):
        {user_id, auth_date?, chat_type?, first_name?, language_code?, bot_id?, other_key?}. The user is the one Telegram
        knows from updates, or a synthetic one. `auth_date` defaults to now; `bot_id` signs for another bot and
        `other_key` with a key nobody checks with, for the refusals. Nothing of it is kept."""
        if not isinstance(body,dict) or set(body)-{'user_id','auth_date','chat_type','first_name','language_code','bot_id','other_key'}:raise ValueError('invalid_fixture_launch')
        seed=os.environ.get(LAUNCH_KEY_ENV,'')
        if not re.fullmatch(r'[0-9a-f]{64}',seed):raise LookupError('fixture_launch_key_missing')
        user_id,auth_date=body.get('user_id'),body.get('auth_date',int(time.time()))
        if type(user_id) is not int or user_id<=0 or type(auth_date) is not int or auth_date<=0:raise ValueError('invalid_fixture_launch')
        user=dict(self.state.get('users',{}).get(str(user_id)) or person_user(user_id))
        user={key:user[key] for key in ('id','first_name','last_name','username') if key in user}
        if 'first_name' in body:
            if not isinstance(body['first_name'],str) or not 1<=len(body['first_name'])<=64:raise ValueError('invalid_fixture_launch')
            user['first_name']=body['first_name']
        if 'language_code' in body:
            if not isinstance(body['language_code'],str) or len(body['language_code'])>35:raise ValueError('invalid_fixture_launch')
            user['language_code']=body['language_code']
        user['allows_write_to_pm']=True
        bot=body.get('bot_id')
        if bot is not None and (type(bot) is not int or bot<=0):raise ValueError('invalid_fixture_launch')
        if body.get('other_key') not in (None,True,False):raise ValueError('invalid_fixture_launch')
        return {'init_data':launch_data(user,auth_date,new_launch_key() if body.get('other_key') else seed,bot,body.get('chat_type'))}

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
        self.state['last_update_id']=max([self.state.get('last_update_id',0)]+[item['update_id'] for item in updates])
        presses=self.state.setdefault('presses',[])
        for item in updates:
            if isinstance(item.get('callback_query'),dict) and item not in presses:presses.append(item)
        titles=self.state.setdefault('titles',{})
        for item in updates:
            chat=(item.get('message') or item.get('edited_message') or item.get('my_chat_member') or {}).get('chat') or {}
            if isinstance(chat.get('title'),str) and type(chat.get('id')) is int:titles[str(chat['id'])]=chat['title']
            self.track(item);self.track_people(item)
        self.save();self.changed.set();return {'queued':len(self.state['updates']),'last_update_id':self.state['last_update_id']}

    def track(self,update):
        """Keep this bot's own status in a chat from a my_chat_member update about it, so leaveChat knows whether it is in."""
        change=update.get('my_chat_member')
        if not isinstance(change,dict) or (change.get('new_chat_member') or {}).get('user',{}).get('id')!=BOT['id']:return
        chat=change.get('chat') or {}
        if type(chat.get('id')) is int:self.state.setdefault('members',{})[str(chat['id'])]={'status':change['new_chat_member'].get('status'),'chat':chat}

    def track_people(self,update):
        """Keep what Telegram knows of people in groups, for getChatMember: someone who writes in a group or is added is a
        member there, a left_chat_member left, and a chat_member update sets their new status. A bot's messages (an
        anonymous admin's, a channel's) name nobody."""
        people,users=self.state.setdefault('people',{}),self.state.setdefault('users',{})
        def keep(chat,user,status,is_member=True):
            if not isinstance(user,dict) or type(user.get('id')) is not int or user.get('is_bot'):return
            users[str(user['id'])]=user
            if type(chat) is int and chat<0:people[f'{chat}:{user["id"]}']={'status':status,'is_member':is_member,'user':user}
        message=update.get('message') or update.get('edited_message')
        if isinstance(message,dict):
            chat=(message.get('chat') or {}).get('id')
            if isinstance(message.get('left_chat_member'),dict):keep(chat,message['left_chat_member'],'left')
            else:
                for user in message.get('new_chat_members') or []:keep(chat,user,'member')
                if message.get('from') is not None and not message.get('sender_chat'):keep(chat,message['from'],'member')
        change=update.get('chat_member')
        if isinstance(change,dict):
            new=change.get('new_chat_member') or {}
            if new.get('status') in MEMBER_STATUSES:keep((change.get('chat') or {}).get('id'),new.get('user'),new['status'],new.get('is_member',True))

    def chat_member_of(self,chat,user):
        """getChatMember's answer: (status, body). A person Telegram showed in the group has their last status there;
        someone it knows but never saw there has left; someone it never saw at all is no user it can find."""
        known=self.state.get('members',{}).get(str(chat)) or {}
        if known.get('status') in ('left','kicked'):return self.error(403,'Forbidden: bot is not a member of the supergroup chat')
        found=self.state.get('people',{}).get(f'{chat}:{user}')
        if found:return 200,chat_member(found['user'],found['status'],found.get('is_member',True))
        seen=self.state.get('users',{}).get(str(user))
        if seen:return 200,chat_member(seen,'left')
        return self.error(400,'Bad Request: user not found')

    def next_update_id(self):
        """The id of an update the fake sends on its own: after every update queued so far, and never a multiple of ten,
        which the tester keeps for its own (telegram_scenarios.Fixture.ids), so neither ever takes the other's."""
        number=max([self.state.get('last_update_id',0),self.state['offset']-1]+[item['update_id'] for item in self.state['updates']])+1
        if number%10==0:number+=1
        self.state['last_update_id']=number
        return number

    def emit(self,update):
        """Queue an update Telegram itself sends, such as the one reporting the bot's own leave."""
        self.state['updates'].append(update);self.track(update);self.changed.set()

    def configure(self,body):
        """Bounded synthetic files/faults; reject malformed control atomically."""
        if not isinstance(body,dict) or set(body)-{'files','faults','drop_faults','chats','chat_members'}:raise ValueError('invalid_fixture_control')
        files=dict(self.state['files']);faults=list(self.state['faults']);chats=dict(self.state.get('chats',{}))
        # Faults a scenario queued that the bot never used, dropped by method so they cannot answer a later scenario's call.
        drop=body.get('drop_faults',[])
        if not isinstance(drop,list) or not all(method in ('sendMessage','getFile','getUpdates','leaveChat','getChatMember') for method in drop):
            raise ValueError('invalid_fixture_control')
        faults=[fault for fault in faults if fault['method'] not in drop]
        people=dict(self.state.get('people',{}));users=dict(self.state.get('users',{}))
        # A person's status in a group as Telegram would now answer getChatMember, such as someone removed while the bot
        # missed the service message. A later message of theirs there shows them in again, as it would.
        for row in body.get('chat_members',[]):
            if (not isinstance(row,dict) or set(row)-{'chat_id','user_id','status','is_member'} or type(row.get('chat_id')) is not int
                    or row['chat_id']>=0 or type(row.get('user_id')) is not int or row['user_id']<=0 or row.get('status') not in MEMBER_STATUSES
                    or ('is_member' in row and (row['status']!='restricted' or type(row['is_member']) is not bool))):raise ValueError('invalid_fixture_chat_member')
            user=users.get(str(row['user_id'])) or person_user(row['user_id'])
            users[str(row['user_id'])]=user
            people[f'{row["chat_id"]}:{row["user_id"]}']={'status':row['status'],'is_member':row.get('is_member',True),'user':user}
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
                    or row.get('method') not in ('sendMessage','getFile','getUpdates','leaveChat','getChatMember')
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
        if len(chats)>50 or len(people)>2000:raise ValueError('fixture_control_limit')
        self.state.update(files=files,faults=faults,chats=chats,people=people,users=users);self.save()
        return {'files':len(files),'faults':len(faults),'chats':len(chats),'chat_members':len(people)}

    @staticmethod
    def markup(data):
        """The inline keyboard of a send or edit: None when absent, False when malformed."""
        markup=data.get('reply_markup')
        if markup in (None,''):return None
        try:markup=json.loads(markup) if isinstance(markup,str) else markup
        except ValueError:return False
        rows=markup.get('inline_keyboard') if isinstance(markup,dict) else None
        if not isinstance(rows,list) or not all(isinstance(row,list) and all(isinstance(button,dict) and isinstance(button.get('text'),str)
                and (not isinstance(button.get('callback_data'),str) or len(button['callback_data'].encode())<=64) for button in row) for row in rows):return False
        return {'inline_keyboard':rows}

    def find(self,data):
        """The sent message a call names by chat and message ID."""
        try:chat,number=int(data.get('chat_id')),int(data.get('message_id'))
        except (TypeError,ValueError):return None
        return next((row for row in self.state['sent'] if row['message']['chat']['id']==chat and row['message']['message_id']==number),None)

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
            if data.get('entities') and not data.get('parse_mode'):
                # Plain text with explicit entities, as approval cards send their links.
                entities=data['entities'];entities=json.loads(entities) if isinstance(entities,str) else entities
                if not isinstance(entities,list):return self.error(400,'Bad Request: invalid entities')
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
            result={'message_id':self.state['next_message_id'],'date':int(time.time()),'from':BOT_USER,
                'chat':{'id':chat,'type':'private' if chat>0 else 'supergroup',**({'title':self.state.get('titles',{}).get(str(chat))} if self.state.get('titles',{}).get(str(chat)) else {})},'text':text,
                **({'entities':entities} if entities else {})}
            if topic is not None:result.update(message_thread_id=int(topic),is_topic_message=True)
            markup=self.markup(data)
            if markup is False:return self.error(400,'Bad Request: invalid reply markup')
            if markup:result['reply_markup']=markup
            self.state['sent'].append({'parameters':data,'message':result})
        elif method=='editMessageText':
            # https://core.telegram.org/bots/api#editmessagetext: only a message this
            # bot sent can be edited; an identical edit is refused like Telegram does.
            text=data.get('text');found=self.find(data)
            if found is None:return self.error(400,'Bad Request: message to edit not found')
            if not isinstance(text,str) or not 1<=len(text)<=4096:return self.error(400,'Bad Request: invalid message')
            entities=data.get('entities') or [];entities=json.loads(entities) if isinstance(entities,str) else entities
            markup=self.markup(data)
            if markup is False:return self.error(400,'Bad Request: invalid reply markup')
            message=found['message']
            if message.get('text')==text and message.get('reply_markup')==(markup or None) and message.get('entities',[])==entities:
                return self.error(400,'Bad Request: message is not modified')
            message.update(text=text,edit_date=int(time.time()))
            if entities:message['entities']=entities
            else:message.pop('entities',None)
            if markup:message['reply_markup']=markup
            else:message.pop('reply_markup',None)
            found.setdefault('edits',[]).append({'parameters':data,'at':time.time()})
            result=message
        elif method=='answerCallbackQuery':
            # https://core.telegram.org/bots/api#answercallbackquery: answers a press
            # the fixture delivered; an unknown or repeated answer is refused. Outside a game, its url may only be a
            # t.me link that opens this bot with a start parameter.
            query=str(data.get('callback_query_id') or '');answers=self.state.setdefault('answers',[])
            pressed={str(item['callback_query']['id']) for item in self.state.setdefault('presses',[])}
            if query not in pressed or any(row['callback_query_id']==query for row in answers):
                return self.error(400,'Bad Request: query is too old and response timeout expired or query ID is invalid')
            url=data.get('url')
            if url is not None and not (isinstance(url,str) and re.fullmatch(r'https://t\.me/'+re.escape(BOT['username'])+r'\?start=[A-Za-z0-9_-]{1,64}',url)):
                return self.error(400,'Bad Request: URL_INVALID')
            answers.append({'callback_query_id':query,'text':data.get('text'),**({'url':url} if url is not None else {}),'at':time.time()});result=True
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
        elif method=='getChatMember':
            # https://core.telegram.org/bots/api#getchatmember: a person's status in a group the bot is in, as the
            # fixture saw it or the tester set it. A private chat has no members to ask about.
            try:chat,user=int(data.get('chat_id')),int(data.get('user_id'))
            except (TypeError,ValueError):return self.error(400,'Bad Request: chat not found')
            if chat>=0:return self.error(400,'Bad Request: chat member status can\'t be requested in a private chat')
            status,result=self.chat_member_of(chat,user)
            if status!=200:return status,result
        elif method=='sendChatAction':
            # https://core.telegram.org/bots/api#sendchataction: a status shown for up to five seconds.
            if data.get('action') not in ('typing','upload_photo','record_video','upload_video','record_voice','upload_voice',
                                          'upload_document','choose_sticker','find_location','record_video_note','upload_video_note'):
                return self.error(400,'Bad Request: wrong parameter action in request')
            result=True
        elif method=='setMessageReaction':
            # https://core.telegram.org/bots/api#setmessagereaction: a bot sets at most one
            # reaction per message, from the fixed emoji list; none clears its own.
            reaction=data.get('reaction') or [];reaction=json.loads(reaction) if isinstance(reaction,str) else reaction
            try:chat,number=int(data.get('chat_id')),int(data.get('message_id'))
            except (TypeError,ValueError):return self.error(400,'Bad Request: message to react not found')
            if (not isinstance(reaction,list) or len(reaction)>1 or any(not isinstance(item,dict) or item.get('type')!='emoji'
                    or item.get('emoji') not in REACTIONS for item in reaction)):return self.error(400,'Bad Request: REACTION_INVALID')
            self.state.setdefault('reactions',{})[f'{chat}:{number}']=[item['emoji'] for item in reaction];result=True
        elif method=='leaveChat':
            # https://core.telegram.org/bots/api#leavechat: the bot leaves a group. Telegram then reports the change of
            # its own status like any other, in a my_chat_member update whose `from` is the bot itself. A chat the bot
            # already left is refused; the fixture never stops delivering a chat's updates, so a late one still arrives.
            try:chat=int(data.get('chat_id'))
            except (TypeError,ValueError):return self.error(400,'Bad Request: chat not found')
            if chat>=0:return self.error(400,'Bad Request: chat not found')
            known=self.state.setdefault('members',{}).get(str(chat)) or {}
            if known.get('status') in ('left','kicked'):return self.error(403,'Forbidden: bot is not a member of the group chat')
            title=self.state.get('titles',{}).get(str(chat))
            group=known.get('chat') or {'id':chat,'type':'supergroup',**({'title':title} if title else {})}
            self.emit(bot_status(self.next_update_id(),group,BOT_USER,known.get('status') or 'member','left'))
            self.state.setdefault('left',[]).append({'chat_id':chat,'at':time.time()});result=True
        elif method in ('setChatMenuButton','getChatMenuButton'):
            # https://core.telegram.org/bots/api#setchatmenubutton: a private chat's own button, or with no chat_id the
            # default every private chat without its own shows. Each set is recorded in order, so the tester sees what
            # Settings Apply set (ADR-0265 D11).
            chat=data.get('chat_id')
            if chat not in (None,''):
                try:chat=int(chat)
                except (TypeError,ValueError):return self.error(400,'Bad Request: chat not found')
                if chat<=0:return self.error(400,'Bad Request: chat not found')
            else:chat=None
            buttons=self.state.setdefault('menu_buttons',{})
            if method=='getChatMenuButton':result=buttons.get(str(chat) if chat is not None else 'default') or buttons.get('default') or {'type':'default'}
            else:
                button=data.get('menu_button') or {'type':'default'}
                try:button=json.loads(button) if isinstance(button,str) else button
                except ValueError:return self.error(400,'Bad Request: can\'t parse menu button JSON object')
                if not menu_button_valid(button):return self.error(400,'Bad Request: invalid menu button specified')
                buttons[str(chat) if chat is not None else 'default']=button
                self.state.setdefault('menu_button_sets',[]).append({'chat_id':chat,'menu_button':button,'at':time.time()})
                result=True
        elif method in ('setMyCommands','deleteMyCommands','getMyCommands'):
            # https://core.telegram.org/bots/api#setmycommands: one list per scope
            # and language; an absent scope is the default scope.
            scope=data.get('scope') or {'type':'default'};scope=json.loads(scope) if isinstance(scope,str) else scope
            key=json.dumps([scope,data.get('language_code') or ''],sort_keys=True);menus=self.state.setdefault('commands',{})
            if method=='setMyCommands':
                commands=data.get('commands');commands=json.loads(commands) if isinstance(commands,str) else commands
                if not isinstance(commands,list):return self.error(400,'Bad Request: invalid commands')
                menus[key]=commands;result=True
            elif method=='deleteMyCommands':menus.pop(key,None);result=True
            else:result=menus.get(key,[])
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

        @app.post('/fixture/telegram/launch')
        async def launch(request:Request):
            try:return self.launch(await request.json())
            except LookupError as error:return JSONResponse({'error':str(error)},status_code=409)
            except (ValueError,TypeError):return JSONResponse({'error':'invalid_fixture_launch'},status_code=400)

        @app.post('/fixture/telegram/control')
        async def configure(request:Request):
            try:return self.configure(await request.json())
            except (ValueError,TypeError,KeyError):return JSONResponse({'error':'invalid_fixture_control'},status_code=400)
