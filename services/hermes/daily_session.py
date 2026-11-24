"""One Hermes session per chat per day (ADR-0288).

A chat's conversation (a group's main thread, each forum topic, the owner's or a member's private chat) moves to a
new Hermes session on its first message of a new day, so no session grows without end. A day starts at 04:00 in the
chat's time zone, and a conversation still going then keeps its session until it has been quiet for half an hour.
The new session starts with the last few messages of the one before, so a short follow-up still has what it answers,
and the earlier one is closed the way Hermes closes a session on its own daily reset, so session search still finds
it. What lasts longer than a day lives in long-term memory and the archive, which every turn reads as before.
Telegram sees none of this: the chat stays one chat.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# A day starts at this hour of the chat's time zone, when nearly nobody is mid-conversation.
DAY_START_HOUR=4
# A conversation still going at the day's start keeps its session until it has been quiet this long.
QUIET_SECONDS=30*60
# Hermes's own end reason for a session its daily reset closed: session search treats it as a boundary, not as the
# current conversation, so its messages stay findable.
END_REASON='daily'


def zone(name):
    """The chat's time zone, or UTC when Nocheh sent none or one this system does not know."""
    try:return ZoneInfo(name) if isinstance(name,str) and 0<len(name)<=64 else timezone.utc
    except Exception:return timezone.utc


def day_of(moment,place):
    """The chat's day at `moment` (Unix seconds), as YYYY-MM-DD; it turns at DAY_START_HOUR."""
    return (datetime.fromtimestamp(moment,place)-timedelta(hours=DAY_START_HOUR)).strftime('%Y-%m-%d')


def cursor_value(raw):
    """A cursor's saved session, its day and its last finished turn; anything malformed reads as no day."""
    if not isinstance(raw,dict) or not isinstance(raw.get('session_id'),str) or not 0<len(raw['session_id'])<=256:return None
    day=raw.get('day') if isinstance(raw.get('day'),str) and len(raw['day'])==10 else None
    active=raw.get('last_active') if type(raw.get('last_active')) in (int,float) else None
    return {'session_id':raw['session_id'],'day':day,'last_active':active}


def choose(cursor,logical,now,place,follow_up=False):
    """The session a turn runs in, the earlier session it starts from (None when it continues one) and the day the
    session belongs to.

    A chat's first session keeps the fixed id it always had. A later day's session is named by its day, so a retried
    turn lands in the same one. A follow-up after an approval always stays in the session that asked for it."""
    today=day_of(now,place)
    if cursor is None:return 'nocheh-'+logical,None,today
    session,day,active=cursor['session_id'],cursor['day'],cursor['last_active']
    # A cursor from before daily sessions has no day: it counts as today's, and the next day starts a new one.
    if day is None or day==today or follow_up:return session,None,day or today
    if active is not None and now-active<QUIET_SECONDS:return session,None,day
    fresh='nocheh-'+logical+'-'+today.replace('-','')
    return (session,None,day) if fresh==session else (fresh,session,today)


def start(store,session,previous,carry,source='telegram'):
    """Open `session` with the last `carry` messages of `previous` (the chat's setting), then close `previous` as a daily reset. Safe to repeat: a
    session already opened keeps what it has."""
    from persistence.conversation.messages import NewMessage
    from persistence.conversation.sessions import NewSession, SessionLineageKind
    from .native_store import messages, session_row
    from .profile_history import _conversation as conversation
    if store.sessions.get(session) is None:
        old=session_row(store,previous)
        tail=conversation(messages(store,previous,latest=True,limit=carry*3))[-carry:] if old and carry>0 else []
        store.sessions.create(NewSession(session_id=session,source=str(old.get('source') or source) if old else source,
            parent_session_id=previous if old else None,lineage_kind=SessionLineageKind.RESET if old else SessionLineageKind.NONE))
        if tail:store.messages.append_batch(session,[NewMessage.from_live(message) for message in tail])
    if session_row(store,previous):store.sessions.promote_to_reset(previous,END_REASON)


def label(day):
    """A session's day as its title shows it, such as '24 Nov'."""
    try:return datetime.strptime(day,'%Y-%m-%d').strftime('%-d %b')
    except (TypeError,ValueError):return None
