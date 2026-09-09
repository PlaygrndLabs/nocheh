"""Native profile routing with a fail-closed Nocheh conversation allowlist."""
from dataclasses import dataclass
import hashlib
import hmac
import base64
import time
import json
import re
from pathlib import Path


def verify_capability(credential,secret,scope,event_id):
    try:
        prefix,body,signature=credential.split('.')
        expected=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        claims=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        if prefix!='turn' or claims.get('event_id')!=event_id or not hmac.compare_digest(signature,expected) or claims.get('audience')!='nocheh-assistant' or claims.get('scope')!=(None if scope.owner else scope.chat_id) or not time.time()*1000<claims['expires']<=time.time()*1000+3600000:
            raise ValueError()
        if claims.get('space') is not None:
            if claims['space'] != scope.space or type(claims.get('revision')) is not int or claims['revision'] < 1:raise ValueError()
        elif scope.space != scope.chat_id:raise ValueError()
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


class Scopes:
    def __init__(self, value):
        if not isinstance(value,dict) or not isinstance(value.get('enabled'),bool): raise ValueError('invalid_assistant_policy')
        self.enabled=value['enabled'];self.owner=value.get('owner_id');self.groups=value.get('group_ids')
        if self.owner is not None and (not isinstance(self.owner,str) or not re.fullmatch(r'[1-9]\d{0,18}',self.owner)):raise ValueError('invalid_owner')
        if not isinstance(self.groups,list) or any(not isinstance(g,str) or not re.fullmatch(r'-\d{1,19}',g) for g in self.groups):raise ValueError('invalid_groups')
        if self.enabled and not self.owner:raise ValueError('owner_required')
        from gateway.profile_routing import parse_profile_routes
        self.routes=parse_profile_routes([{'platform':'telegram','chat_id':chat,'profile':self.profile(chat),'name':chat}
                                          for chat in ([self.owner] if self.owner else [])+self.groups])

    @classmethod
    def load(cls,path):
        from .environment import telegram_policy
        return cls(json.loads(Path(path).read_text()) if path else telegram_policy())

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
        return scope

    def resolve(self,update,expected_scope):
        if not self.enabled:return None
        message=update.get('message')
        if not isinstance(message,dict):return None
        chat=message.get('chat',{});sender=message.get('from',{})
        chat_id=str(chat.get('id',''));user_id=str(sender.get('id',''))
        if chat_id!=expected_scope:raise ValueError('source_scope_mismatch')
        if sender.get('is_bot') or not user_id:return None
        owner=chat.get('type')=='private' and chat_id==self.owner and user_id==self.owner
        if not owner and (chat.get('type') not in ('group','supergroup') or chat_id not in self.groups):return None
        from gateway.profile_routing import match_profile_route
        route=match_profile_route(self.routes,'telegram',chat_id=chat_id)
        if not route:raise ValueError('missing_profile_route')
        topic=message.get('message_thread_id')
        if topic is not None and (type(topic) is not int or topic<=0):raise ValueError('invalid_topic')
        space=chat_id if topic is None else chat_id+'/topic/'+str(topic)
        return Scope(chat_id,user_id,owner,route.profile,space)
