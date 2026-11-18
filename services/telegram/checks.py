"""What one send may do: each physical Bot API request is bound to its chat, topic, message and current authority."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import urllib.request

from services.durable import canonical
from .capture import Held
from .settings import archive_url, secret

# A send that made no admitted request reached nothing, so the caller may retry under a fresh attempt.
NOT_TRANSMITTED = {'state':'failed','error_code':'assistant_runtime_unavailable','error_stage':'telegram_send_not_transmitted'}
# The reactions on the message a turn answers: 👀 while it works, then 👍 when answered or 👎 when it failed.
EYES, THUMBS_UP, THUMBS_DOWN = '\U0001f440', '\U0001f44d', '\U0001f44e'
WORKING_REACTIONS = frozenset((EYES, THUMBS_UP, THUMBS_DOWN))
SOURCE_CITATION = re.compile(r'\s*【nocheh:event:[a-f0-9]{64}】')
SOURCE_ID = re.compile(r'nocheh:event:[a-f0-9]{64}')
# The formatting an approval card may carry: bold labels, a quote shown whole or one that opens on a tap, such as an
# operation's arguments folded under its summary, and a command as code.
APPROVAL_FORMATS = frozenset({'bold','blockquote','expandable_blockquote','pre'})


def render_reply_citations(text):
    """Keep internal archive identifiers out of Telegram-visible prose."""
    return SOURCE_ID.sub('the Archive', SOURCE_CITATION.sub('', text))


def outbound_check(chat_id, topic, authorized, cancelled=None, requests=None, markup=None):
    """Bind every physical send to the authorized conversation, including retries: its Telegram chat and topic.

    ``requests`` records each message request admitted for transmission, so a
    failed delivery with none admitted is known not to have reached Telegram.
    ``markup`` is the one keyboard a send may carry; any other is held, and
    without one no request carries a keyboard.
    """
    topic = None if topic is None or topic == '' else int(topic)
    expected = None if markup is None else markup.to_dict() if hasattr(markup, 'to_dict') else markup

    def check(method, parameters):
        if (method not in ('sendMessage', 'sendChatAction') or
                str(parameters.get('chat_id')) != str(chat_id) or
                parameters.get('message_thread_id') not in ((None, 1) if topic == 1 else (topic,)) or
                parameters.get('direct_messages_topic_id') is not None or
                parameters.get('ephemeral_message_parameters') is not None or
                parameters.get('reply_markup') not in (None, expected)):
            raise Held('telegram_delivery_audience_changed')
        if cancelled is not None and cancelled.is_set():
            raise Held('telegram_delivery_cancelled')
        if not authorized():
            raise Held('telegram_delivery_authority_revoked')
        if requests is not None and method != 'sendChatAction':
            requests.append({'method': method, 'state': None, 'status': None})

    def observe(method, state, status):
        # Record the journal's outcome for the most recent admitted request.
        for entry in reversed(requests or []):
            if entry['method'] == method and entry['state'] is None:
                entry.update(state=state, status=status)
                break
    check.observe = observe
    return check


def leave_check(chat_id):
    """Bind a leave to the one chat Nocheh was asked to leave: leaveChat there, and no other request."""
    def check(method, parameters):
        if method != 'leaveChat' or set(parameters) != {'chat_id'} or str(parameters.get('chat_id')) != str(chat_id):
            raise Held('telegram_delivery_audience_changed')
    return check


def reaction_check(chat_id, message_id, authorized):
    """Bind a working reaction to the one message a turn answers.

    Only the three working reactions, or clearing them, pass. A cancelled
    turn may still clear its 👀, so cancellation does not refuse it; a revoked
    space does.
    """
    def check(method, parameters):
        reaction = parameters.get('reaction', [])
        if (method != 'setMessageReaction' or set(parameters) - {'chat_id', 'message_id', 'reaction'} or
                str(parameters.get('chat_id')) != str(chat_id) or str(parameters.get('message_id')) != str(message_id) or
                not isinstance(reaction, list) or len(reaction) > 1 or
                any(not isinstance(item, dict) or set(item) != {'type', 'emoji'} or item['type'] != 'emoji' or
                    item['emoji'] not in WORKING_REACTIONS for item in reaction)):
            raise Held('telegram_delivery_audience_changed')
        if not authorized():
            raise Held('telegram_delivery_authority_revoked')
    return check


def delivery_failure(requests):
    """Classify a failed send from its admitted requests and their outcomes."""
    if requests == []:
        return dict(NOT_TRANSMITTED)
    if requests and all(entry['state'] == 'rejected' for entry in requests):
        # Telegram answered every attempt with a definite error, so nothing was
        # delivered. A rate limit stays retryable; other errors are terminal.
        # The last answer decides: a plain-text resend after a formatting
        # rejection that is then rate limited still deserves a retry.
        if requests[-1]['status'] == 429:
            return {**NOT_TRANSMITTED, 'error_stage': 'telegram_rate_limited'}
        return {'state': 'suppressed', 'error_code': 'telegram_rejected'}
    return None


def no_preview():
    """Link previews off on every message Nocheh sends or edits. Telegram fetches
    an address to preview it, so one placed in a card or reply would be fetched before
    the owner has read it."""
    from telegram import LinkPreviewOptions
    return LinkPreviewOptions(is_disabled=True)


def approval_links(links,length):
    """Entities on an approval card's plain text: a group's, topic's or message's t.me address over its name,
    and the formatting of an operation's arguments. Nothing else, and at most Telegram's 100."""
    if links is None:return None
    from telegram import MessageEntity
    if not isinstance(links,list) or len(links)>100:raise ValueError('invalid_approval')
    entities=[]
    for link in links:
        if not isinstance(link,dict):raise ValueError('invalid_approval')
        offset,size,url,kind=(link.get(key) for key in ('offset','length','url','type'))
        if type(offset) is not int or type(size) is not int or not 0<=offset<offset+size<=length:raise ValueError('invalid_approval')
        if kind is None and isinstance(url,str) and set(link)=={'offset','length','url'} and re.fullmatch(
                r'https://t\.me/(?:c/[1-9]\d{0,15}|[A-Za-z][A-Za-z0-9_]{3,31})(?:/[1-9]\d{0,15}){0,2}',url):
            entities.append(MessageEntity(MessageEntity.TEXT_LINK,offset,size,url=url))
        elif kind in APPROVAL_FORMATS and set(link)=={'offset','length','type'}:
            entities.append(MessageEntity(kind,offset,size))
        else:raise ValueError('invalid_approval')
    # They nest only as Telegram allows: bold inside a quote, such as a label in folded arguments, or around another
    # entity; never a quote in a quote, anything with code, or a partial overlap, which Telegram refuses or reads its own way.
    spans=[(link['offset'],link['offset']+link['length'],link.get('type') or 'text_link') for link in links]
    for index,(start,end,kind) in enumerate(spans):
        for other_start,other_end,other in spans[index+1:]:
            if other_start>=end or start>=other_end:continue
            nested=start<=other_start and other_end<=end or other_start<=start and end<=other_end
            if not nested or 'pre' in (kind,other) or 'bold' not in (kind,other):raise ValueError('invalid_approval')
    return entities or None


# Presses on the owner's notices that storage handles: Retry failed under a problem notice, and Pause or Resume under a
# notice about members' job spend (ADR-0251). Storage acts only on the owner's own press in their private chat.
NOTICE_CALLBACKS=('nr','njp','nju')
# The card about a group the owner added Nocheh to (ADR-0253): Move to one of its offered projects (0-2), No project (x)
# or Turn off (o), each with the first 32 hex of the add's archive event.
CARD_CALLBACK=re.compile(r'ng[012xo][a-f0-9]{32}')


def notice_buttons(buttons):
    """Buttons under a notice in the owner's private chat, one row (a list of buttons) or up to three rows (a list of
    lists) of up to three each: open a page in the mini app or a browser, or a press that storage handles
    (NOTICE_CALLBACKS, or CARD_CALLBACK). Anything else is refused."""
    if buttons is None:return None
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
    rows=buttons if isinstance(buttons,list) and buttons and all(isinstance(row,list) for row in buttons) else [buttons]
    if len(rows)>3:raise ValueError('invalid_notice')
    keyboard=[]
    for buttons in rows:
        if not isinstance(buttons,list) or not 0<len(buttons)<=3:raise ValueError('invalid_notice')
        row=[]
        for button in buttons:
            label=button.get('text') if isinstance(button,dict) else None
            if not isinstance(label,str) or not 0<len(label)<=40 or len(button)!=2:raise ValueError('invalid_notice')
            web,url,callback=button.get('web_app'),button.get('url'),button.get('callback')
            if isinstance(web,str) and len(web)<=512 and re.fullmatch(r'https://\S+',web):row.append(InlineKeyboardButton(label,web_app=WebAppInfo(web)))
            elif isinstance(url,str) and len(url)<=512 and re.fullmatch(r'https?://\S+',url):row.append(InlineKeyboardButton(label,url=url))
            elif callback in NOTICE_CALLBACKS or isinstance(callback,str) and CARD_CALLBACK.fullmatch(callback):
                row.append(InlineKeyboardButton(label,callback_data=callback))
            else:raise ValueError('invalid_notice')
        keyboard.append(row)
    return InlineKeyboardMarkup(keyboard)


def answer_button(button, chat_id, event_id, served):
    """The one button a turn's reply may carry: Answer privately under the owner's answer in a group (ADR-0249).

    Only in a served group, as the served list has it now: never in any private chat, the owner's or a member's (step 4).
    Its label is short, and its data is ``np`` and the record id Nocheh derives from this very turn's question with the
    service token, so no other answer's button can ride on this reply."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    if button is None: return None
    if not isinstance(button, dict) or set(button) != {'text', 'data'} or served.group(served.resolve(str(chat_id))) is None: raise ValueError('invalid_reply')
    label, data = button['text'], button['data']
    if not isinstance(label, str) or not 0 < len(label) <= 40 or not label.strip() or not isinstance(data, str): raise ValueError('invalid_reply')
    record = hmac.new(secret('SERVICE_TOKEN').encode(), ('private-answer:' + str(event_id)).encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(data, 'np' + record): raise ValueError('invalid_reply')
    return InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data=data)]])


def verify_turn_credential(credential, event_id, chat_id, topic, policy):
    """The turn credential Nocheh minted for this event and conversation, unexpired and signed with the service token,
    and the served list it was checked against.

    It binds a reply or presence to the chat and topic the turn was admitted for (ADR-0252): its app binding names this
    Telegram chat and topic, and the served list agrees that its space (a Nocheh chat id) is there now and belongs to its
    scope: a served group, or for the owner's own turn (no scope) the owner's private chat itself, never a topic of it, as
    Hermes runs the owner's turns only there. Whether the space still
    allows delivery is asked separately, per request (check_delivery_policy). A private answer's pass names its record
    and reads as the owner's private chat, never as the owner, so its scope and space are that chat; anywhere else it is
    refused (ADR-0249). A member's pass (step 4) names that member and reads as their own private chat, which the
    served list marks member_private: its scope and space are that chat, never a topic, never the owner's. The owner's ask
    about a member (member_read, step 4b) reads as the owner's private chat, as an answer does. A pass names at most one
    of these. A lane (a member id, so the brain runs one turn at a time per member) grants nothing; it is taken only on a
    member's own pass, for that member, and on a group pass."""
    try:
        prefix,body,signature=credential.split('.')
        expected=base64.urlsafe_b64encode(hmac.new(secret('SERVICE_TOKEN').encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        if prefix!='turn' or not hmac.compare_digest(signature,expected):raise ValueError()
        claims=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        if (claims.get('event_id')!=event_id or claims.get('audience')!='nocheh-assistant' or
                not time.time()*1000<claims['expires']<=time.time()*1000+3600000):raise ValueError()
        if claims.get('app')!={'app':'telegram','chat':str(chat_id),'topic':None if topic is None else str(topic)}:raise ValueError()
        scope,space,answer=claims.get('scope'),claims.get('space'),claims.get('answer')
        member,member_read,lane=claims.get('member'),claims.get('member_read'),claims.get('lane')
        if not isinstance(space,str) or type(claims.get('revision')) is not int or claims['revision']<1:raise ValueError()
        # Storage binds what a member may read on the server; a pass never carries it, under any spelling.
        if any(key in claims for key in ('reads','member_chat','memberChat','memberRead')):raise ValueError()
        if sum(value is not None for value in (answer,member,member_read))>1:raise ValueError()
        if lane is not None and (not isinstance(lane,str) or not re.fullmatch(r'[a-f0-9]{64}',lane) or scope is None or
                                 answer is not None or member_read is not None or member is not None and lane!=member):raise ValueError()
        epoch=claims.get('guard_epoch')
        # A topic first used a moment ago, or a group's new Telegram id, is only in a list read after the app recorded it.
        served=policy.current(epoch if type(epoch) is int else None,60.0,lambda served:served.binding(space)==claims['app'])
        if served.binding(space)!=claims['app']:raise ValueError()
        if answer is not None:
            if not isinstance(answer,str) or not re.fullmatch(r'[a-f0-9]{32}',answer) or not served.owner_chat or scope!=served.owner_chat or space!=scope:raise ValueError()
        elif member_read is not None:
            if not isinstance(member_read,str) or not re.fullmatch(r'[a-f0-9]{32}',member_read) or not served.owner_chat or scope!=served.owner_chat or space!=scope:raise ValueError()
        elif member is not None:
            if (not isinstance(member,str) or not re.fullmatch(r'[a-f0-9]{64}',member) or not isinstance(scope,str) or space!=scope or
                    not served.member_private(scope) or served.is_owner(scope)):raise ValueError()
        elif scope is None:
            if not served.owner_chat or space!=served.owner_chat:raise ValueError()
        elif served.group(scope)!=scope or space!=scope and served.parent(space)!=scope:raise ValueError()
        return claims,served
    except Exception:raise ValueError('archive_capability_scope_mismatch') from None


def check_delivery_policy(credential):
    try:
        request=urllib.request.Request(archive_url()+'/v1/memory/check',headers={'Authorization':'Bearer '+credential})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False


def check_action_policy(body):
    try:
        request=urllib.request.Request(archive_url()+'/internal/actions/authorize',
            data=canonical({key:body[key] for key in ('id','destination','chat_id','topic','text') if key in body}),
            headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False


def check_leave_policy(body):
    """The app's last word on a leave (ADR-0253): True while the group whose Telegram id is `chat_id` is still pending
    from the add `id`, False once the owner turned it on or off or it was added again, None when the app cannot answer."""
    try:
        request=urllib.request.Request(archive_url()+'/internal/chats/leave',data=canonical({'id':body['id'],'chat_id':body['chat_id']}),
            headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=10) as response:valid=json.loads(response.read(1024)).get('valid')
    except Exception:return None
    return valid if isinstance(valid,bool) else None
