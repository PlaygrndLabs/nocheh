"""Native profile routing with a fail-closed Nocheh conversation allowlist."""
from dataclasses import dataclass
import hashlib
import hmac
import base64
import time
import json
import re
import os
from pathlib import Path


def topic_id(message):
    """The forum topic a Telegram message belongs to, or None.

    Bot API also sets message_thread_id on a reply chain in an ordinary
    supergroup; that anchor is not a topic and is never a delivery destination.
    Same rule as the native adapter's routable thread id."""
    chat=message.get('chat') if isinstance(message.get('chat'),dict) else {}
    raw=message.get('message_thread_id')
    if raw is None:return None
    forum=chat.get('type') in ('group','supergroup') and chat.get('is_forum') is True
    return raw if forum or message.get('is_topic_message') is True else None


def verify_capability(credential,secret,scope,event_id):
    try:
        prefix,body,signature=credential.split('.')
        expected=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        claims=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        # A private answer's pass names its record and reads as the owner's private chat, never as the owner: only in that
        # chat, with the chat itself as its scope (ADR-0249).
        answer=claims.get('answer')
        if answer is not None and (not scope.owner or not isinstance(answer,str) or not re.fullmatch(r'[a-f0-9]{32}',answer)):raise ValueError()
        if prefix!='turn' or claims.get('event_id')!=event_id or not hmac.compare_digest(signature,expected) or claims.get('audience')!='nocheh-assistant' or claims.get('scope')!=(None if scope.owner and answer is None else scope.chat_id) or not time.time()*1000<claims['expires']<=time.time()*1000+3600000:
            raise ValueError()
        if claims.get('space') is not None:
            if claims['space'] != scope.space or type(claims.get('revision')) is not int or claims['revision'] < 1:raise ValueError()
        elif scope.space != scope.chat_id:raise ValueError()
        generation=claims.get('generation')
        if generation is not None and not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',str(generation)):raise ValueError()
        if generation is not None and (type(claims.get('guard_epoch')) is not int or claims['guard_epoch']<1):raise ValueError()
        if os.environ.get('NOCHEH_STORAGE_LAYOUT')=='original-only-v1' and generation is None:raise ValueError()
        if claims.get('purpose','assistant') not in ('assistant','memory-review','filter'):raise ValueError()
        if 'logical_profile' in claims and (generation is None or not isinstance(claims['logical_profile'],str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',claims['logical_profile'])):raise ValueError()
        if scope.logical_profile and claims.get('logical_profile')!=scope.logical_profile:raise ValueError()
        if 'project' in claims and (not isinstance(claims['project'],str) or not re.fullmatch(r'[a-f0-9]{64}',claims['project'])):raise ValueError()
        # A Telegram turn is bound to where its chat is in the app (ADR-0251); a job's or the dashboard's pass names none.
        if scope.app and claims.get('app')!={'app':scope.app[0],'chat':scope.app[1],'topic':scope.app[2]}:raise ValueError()
        return claims
    except Exception:raise ValueError('archive_capability_scope_mismatch') from None


@dataclass(frozen=True)
class Scope:
    chat_id: str
    user_id: str
    owner: bool
    profile: str
    space: str = ''
    revision: int = 0
    guard_epoch: int = 0
    generation: str = ''
    purpose: str = 'assistant'
    logical_profile: str = ''
    project: str = ''
    answer: str = ''
    # Where a Telegram turn's chat is in its app now, as its pass binds it: ('telegram', chat id, topic key or None).
    app: tuple = ()


class Scopes:
    """Who Nocheh's brain serves (ADR-0251). Whether it is on and each group's member access come from its environment;
    the owner, the owner's private chat and the served groups come from the app's served list (services/chats.py), by
    their Nocheh chat ids and their Telegram ids now and before. A turn's chat, space and app binding come from its
    signed pass, and its profile is built for that chat per request. A list that cannot be read serves nothing."""
    def __init__(self, value, served=None):
        if not isinstance(value,dict) or not isinstance(value.get('enabled'),bool): raise ValueError('invalid_assistant_policy')
        from services.chats import Fixed,Served,ServedList
        self.enabled=value['enabled']
        if served is None and ('owner_id' in value or 'group_ids' in value):
            # A policy file of tests and checks: chats stored before step 2b, whose chat id is their Telegram id, and the
            # topics it lists as (topic id, chat id, key).
            owner,groups,topics=value.get('owner_id'),value.get('group_ids',[]),value.get('topics',[])
            if owner is not None and not isinstance(owner,str) or not isinstance(groups,list) or not isinstance(topics,list):raise ValueError('invalid_assistant_policy')
            served=Served.of(owner,groups=groups,topics=[tuple(topic) for topic in topics])
        if self.enabled and isinstance(served,Served) and not served.owner_chat:raise ValueError('owner_required')
        self.group_access=value.get('group_access',{})
        # Keyed by any Telegram id a group has had; a key that names no served group grants nothing.
        if not isinstance(self.group_access,dict) or len(self.group_access)>100:raise ValueError('invalid_group_access')
        for group,entry in self.group_access.items():
            if not isinstance(group,str) or not 0<len(group)<=32 or not isinstance(entry,dict) or set(entry)!={'granted','denied'}:raise ValueError('invalid_group_access')
            for users in entry.values():
                if not isinstance(users,list) or len(users)>1000 or any(not telegram_user(user) for user in users):raise ValueError('invalid_group_access')
        from .environment import secret
        self.served=Fixed(served) if isinstance(served,Served) else served or ServedList(None,lambda:secret('SERVICE_TOKEN'))

    def current(self,epoch=None,max_age=5.0,holds=None):
        """The served list as the app has it now: read again when older than `max_age` seconds, when a pass carries a
        newer guard epoch than it was read at, or when it does not hold what `holds` asks for (a topic or Telegram id the
        app recorded since)."""
        return self.served.get(epoch,max_age,holds)

    def access(self,served,group,user):
        """Whether `user` may talk to Nocheh in the served group `group` (a Nocheh chat id): granted and not denied, under any
        Telegram id the group has had, so an upgrade keeps who may talk there."""
        entries=[self.group_access.get(external,{}) for external in served.app_ids(group)]
        return any(user in entry.get('granted',[]) for entry in entries) and not any(user in entry.get('denied',[]) for entry in entries)

    @classmethod
    def load(cls,path):
        from .environment import telegram_policy
        return cls(json.loads(Path(path).read_text()) if path else telegram_policy())

    @staticmethod
    def claims(credential):
        """The claims a turn pass carries, before they are verified: only to know which chat it names, never as authority."""
        try:
            body=credential.split('.')[1]
            claims=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
            if not isinstance(claims,dict):raise ValueError()
            return claims
        except Exception:raise ValueError('archive_capability_scope_mismatch') from None

    @staticmethod
    def profile(chat):return 'nocheh-'+hashlib.sha256(chat.encode()).hexdigest()[:24]

    @staticmethod
    def apply_revision(scope,claims):
        from dataclasses import replace
        if not scope.owner and claims.get('revision'):
            scope=replace(scope,profile=Scopes.profile(scope.space+':policy:'+str(claims['revision'])),revision=claims['revision'])
        epoch=claims.get('guard_epoch')
        if epoch is not None:
            if type(epoch) is not int or epoch<1:raise ValueError('invalid_guard_generation')
            scope=replace(scope,profile=Scopes.profile((scope.space or scope.chat_id)+':policy:'+str(scope.revision)+':guard:'+str(epoch)),guard_epoch=epoch)
        generation=claims.get('generation')
        logical=claims.get('logical_profile')
        if 'logical_profile' in claims and (generation is None or not isinstance(logical,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',logical)):
            raise ValueError('invalid_logical_profile')
        # A private answer is its own conversation: its record is part of its profile, which is never the owner's (ADR-0249).
        answer=claims.get('answer')
        if 'answer' in claims and (generation is None or scope.owner or not isinstance(answer,str) or not re.fullmatch(r'[a-f0-9]{32}',answer)):
            raise ValueError('invalid_private_answer')
        if generation is not None:
            if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',str(generation)) or type(epoch) is not int or epoch<1:
                raise ValueError('invalid_installation_generation')
            purpose=claims.get('purpose','assistant')
            if purpose not in ('assistant','memory-review','filter'):raise ValueError('invalid_turn_purpose')
            # Reviews share native notes and the foreground lock; filtering has
            # a separate context. Prepared-text caches remain purpose-specific.
            identity=[generation,scope.space or scope.chat_id,'owner' if scope.owner else 'scoped',epoch,'filter' if purpose=='filter' else 'assistant']
            default=Scopes.profile(scope.space or scope.chat_id)
            if logical and logical!=default:identity.append(logical)
            if answer is not None:identity.append('answer:'+answer)
            scope=replace(scope,profile=Scopes.profile(json.dumps(identity,separators=(',',':'),ensure_ascii=False)),generation=generation,purpose=purpose,
                          logical_profile=logical or '',answer=answer or '')
        # The chat's project brings its role and skills; it never changes which profile or history the turn uses.
        project=claims.get('project')
        if project is not None:
            if not isinstance(project,str) or not re.fullmatch(r'[a-f0-9]{64}',project):raise ValueError('invalid_project')
            scope=replace(scope,project=project)
        return scope

    def resolve(self,body,claims):
        """The scope of a Telegram turn: the Nocheh chat and space its pass names, checked against the update it answers.

        The pass's app binding must name this update's chat and topic, and the served list must agree: the update's
        Telegram id (now or before) and topic are that space, which is where the binding says it is now (ADR-0251). The
        owner's own turn (no scope) and a private answer (ADR-0249) are the owner writing in the owner's private chat;
        any other is a served group's member with access. A turn this policy does not serve is None; a pass that does not
        match its update is refused."""
        if not self.enabled:return None
        payload=body.get('payload') if isinstance(body.get('payload'),dict) else {}
        message=payload.get('message')
        if not isinstance(message,dict):return None
        chat=message.get('chat') if isinstance(message.get('chat'),dict) else {}
        sender=message.get('from') if isinstance(message.get('from'),dict) else {}
        external,user_id=str(chat.get('id','')),str(sender.get('id',''))
        if external!=body.get('scope'):raise ValueError('source_scope_mismatch')
        if sender.get('is_bot') or not user_id:return None
        topic=topic_id(message)
        if topic is not None and (type(topic) is not int or topic<=0):raise ValueError('invalid_topic')
        nocheh,space,app=body.get('chat'),body.get('space'),body.get('app')
        if (not isinstance(nocheh,str) or not isinstance(space,str) or not isinstance(app,dict) or app!=claims.get('app') or
                app!={'app':'telegram','chat':app.get('chat'),'topic':None if topic is None else str(topic)} or
                claims.get('space')!=space or claims.get('scope') not in (None,nocheh)):
            raise ValueError('archive_capability_scope_mismatch')
        epoch=claims.get('guard_epoch')
        # A topic first used a moment ago, or a group's new Telegram id, is only in a list read after the app recorded it.
        served=self.current(epoch if type(epoch) is int else None,60.0,lambda served:served.resolve(external,topic)==space)
        # A list that cannot be read is no answer: the turn fails, to be tried again, rather than be dropped as unserved.
        if not served.available:raise RuntimeError('served_chats_unavailable')
        owner=claims.get('scope') is None or claims.get('answer') is not None
        # A chat no longer served (the owner's chat changed, a group left the list) gets no turn.
        if not (served.is_owner(nocheh) if owner else served.group(nocheh)==nocheh):return None
        # A served one: the update is from this chat and topic, by its Telegram id now or before, and the binding is where it
        # is now. The owner's private chat has no topics.
        if (served.resolve(external,topic)!=space or served.binding(space)!=app or served.chat_of(space)!=nocheh or
                owner and space!=nocheh):
            raise ValueError('archive_capability_scope_mismatch')
        if owner:
            if chat.get('type')!='private' or user_id!=served.owner_user():return None
        else:
            if chat.get('type') not in ('group','supergroup'):return None
            if user_id!=served.owner_user() and not self.access(served,nocheh,user_id):return None
        from gateway.profile_routing import match_profile_route,parse_profile_routes
        route=match_profile_route(parse_profile_routes([{'platform':'telegram','chat_id':nocheh,'profile':self.profile(nocheh),'name':nocheh}]),'telegram',chat_id=nocheh)
        if not route:raise ValueError('missing_profile_route')
        return Scope(nocheh,user_id,owner,route.profile,space,app=('telegram',app['chat'],app['topic']))


def telegram_user(value):
    """A Telegram user id as the Bot API writes it: a positive number with no leading zero."""
    return isinstance(value,str) and value.isascii() and value.isdigit() and 0<len(value)<=19 and value[0]!='0'
