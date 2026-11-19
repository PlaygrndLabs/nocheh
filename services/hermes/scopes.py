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
        # A member's pass (step 4) names that member and reads as their own private chat: only for the member scope
        # resolve() built from this very pass, never the owner, an answer or a group. The owner's ask about a member
        # (member_read, step 4b) reads as the owner's private chat and never as the owner, and is never an answer's or a
        # member's too; which chat it reads is bound by storage, never named here. A pass names at most one of these,
        # and never what storage binds on the server.
        member=claims.get('member')
        if (member is not None)!=bool(scope.member) or member is not None and (scope.owner or member!=scope.member or not re.fullmatch(r'[a-f0-9]{64}',member)):raise ValueError()
        member_read=claims.get('member_read')
        if member_read is not None and (not scope.owner or answer is not None or member is not None or not isinstance(member_read,str) or
                                        not re.fullmatch(r'[a-f0-9]{32}',member_read)):raise ValueError()
        if any(key in claims for key in ('reads','member_chat','memberChat','memberRead')):raise ValueError()
        if answer is not None and member is not None:raise ValueError()
        # A lane (a member id) only orders turns: one at a time per member. It is never on the owner's own pass, an
        # answer's or an ask's, and on a member's pass it is that member.
        lane=claims.get('lane')
        if lane is not None and (not isinstance(lane,str) or not re.fullmatch(r'[a-f0-9]{64}',lane) or claims.get('scope') is None or
                                 answer is not None or member_read is not None or member is not None and lane!=member):raise ValueError()
        if prefix!='turn' or claims.get('event_id')!=event_id or not hmac.compare_digest(signature,expected) or claims.get('audience')!='nocheh-assistant' or claims.get('scope')!=(None if scope.owner and answer is None and member_read is None else scope.chat_id) or not time.time()*1000<claims['expires']<=time.time()*1000+3600000:
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
        # A Telegram turn is bound to where its chat is in the app (ADR-0252); a job's or the dashboard's pass names none.
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
    # The member whose own private chat this turn is in (step 4, ADR-0262), as its pass names them: never the owner.
    member: str = ''
    # The owner's ask about a member this turn answers (step 4b): never the owner, never carried, read only.
    member_read: str = ''
    # Where a Telegram turn's chat is in its app now, as its pass binds it: ('telegram', chat id, topic key or None).
    app: tuple = ()


class Scopes:
    """Who Nocheh's brain serves (ADR-0252). Whether it is on comes from its environment; the owner, the owner's private
    chat and the served groups come from the app's served list (services/chats.py), by their Nocheh chat ids and their
    Telegram ids now and before. Who else may talk in a served group is the app's member directory alone (step 3): the
    app admits the sender and signs the turn's pass for this event. A turn's chat, space and app binding come from its
    signed pass, and its profile is built for that chat per request. A list that cannot be read serves nothing. A policy
    names no chat: an owner or groups in a policy file are not read (ADR-0253); a test gives its list as `served`."""
    def __init__(self, value, served=None):
        if not isinstance(value,dict) or not isinstance(value.get('enabled'),bool): raise ValueError('invalid_assistant_policy')
        from services.chats import Fixed,Served,ServedList
        self.enabled=value['enabled']
        if self.enabled and isinstance(served,Served) and not served.owner_chat:raise ValueError('owner_required')
        from .environment import secret
        self.served=Fixed(served) if isinstance(served,Served) else served or ServedList(None,lambda:secret('SERVICE_TOKEN'))

    def current(self,epoch=None,max_age=5.0,holds=None):
        """The served list as the app has it now: read again when older than `max_age` seconds, when a pass carries a
        newer guard epoch than it was read at, or when it does not hold what `holds` asks for (a topic or Telegram id the
        app recorded since)."""
        return self.served.get(epoch,max_age,holds)

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
        # The owner's ask about a member is its own conversation too (step 4b), named by its ask as storage names it.
        member_read=claims.get('member_read')
        if 'member_read' in claims and (generation is None or scope.owner or answer is not None or not isinstance(member_read,str) or
                                        not re.fullmatch(r'[a-f0-9]{32}',member_read)):
            raise ValueError('invalid_member_read')
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
            if member_read is not None:identity.append('member_read:'+member_read)
            scope=replace(scope,profile=Scopes.profile(json.dumps(identity,separators=(',',':'),ensure_ascii=False)),generation=generation,purpose=purpose,
                          logical_profile=logical or '',answer=answer or '',member_read=member_read or '')
        # The chat's project brings its role and skills; it never changes which profile or history the turn uses.
        project=claims.get('project')
        if project is not None:
            if not isinstance(project,str) or not re.fullmatch(r'[a-f0-9]{64}',project):raise ValueError('invalid_project')
            scope=replace(scope,project=project)
        return scope

    def resolve(self,body,claims):
        """The scope of a Telegram turn: the Nocheh chat and space its pass names, checked against the update it answers.

        The pass's app binding must name this update's chat and topic, and the served list must agree: the update's
        Telegram id (now or before) and topic are that space, which is where the binding says it is now (ADR-0252). The
        owner's own turn (no scope), a private answer (ADR-0249) and the owner's ask about a member (step 4b) are the owner writing in the owner's private chat;
        any other is a person writing in a served group, whom the app admitted (its member directory, step 3) before it
        signed this event's pass: a bot, or a message in a chat's own name, never is. A member's pass (step 4) is that
        member writing in their own private chat, which the served list marks member_private, never the owner, with
        `owner` False. A turn this policy does not serve is None; a pass that does not match its update is refused."""
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
        # Whose turn it is, by its pass: the owner (or an answer, or the owner's ask about a member, in the owner's chat),
        # a member in their own private chat, or someone in a served group.
        member=claims.get('member')
        kind='member' if member is not None else 'owner' if claims.get('scope') is None or claims.get('answer') is not None or claims.get('member_read') is not None else 'group'
        if kind=='member' and (claims.get('scope')!=nocheh or claims.get('answer') is not None or claims.get('member_read') is not None):
            raise ValueError('archive_capability_scope_mismatch')
        # A chat no longer served (the owner's chat changed, a group left the list, a member's chat closed) gets no turn.
        if not {'owner':served.is_owner,'member':served.member_private,'group':lambda chat:served.group(chat)==chat}[kind](nocheh):return None
        # A served one: the update is from this chat and topic, by its Telegram id now or before, and the binding is where it
        # is now. A private chat, the owner's or a member's, has no topics.
        if (served.resolve(external,topic)!=space or served.binding(space)!=app or served.chat_of(space)!=nocheh or
                kind!='group' and space!=nocheh):
            raise ValueError('archive_capability_scope_mismatch')
        if kind=='owner':
            if chat.get('type')!='private' or user_id!=served.owner_user():return None
        elif kind=='member':
            # The person writing is the chat's own person, never the owner, and never in a chat's own name.
            if (chat.get('type')!='private' or topic is not None or user_id!=external or user_id==served.owner_user() or
                    served.is_owner(nocheh) or message.get('sender_chat') is not None):return None
        else:
            if chat.get('type') not in ('group','supergroup') or message.get('sender_chat') is not None:return None
        from gateway.profile_routing import match_profile_route,parse_profile_routes
        route=match_profile_route(parse_profile_routes([{'platform':'telegram','chat_id':nocheh,'profile':self.profile(nocheh),'name':nocheh}]),'telegram',chat_id=nocheh)
        if not route:raise ValueError('missing_profile_route')
        return Scope(nocheh,user_id,kind=='owner',route.profile,space,app=('telegram',app['chat'],app['topic']),member=member or '')
