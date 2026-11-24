"""Hermes's own schedule tool (cronjob_manage) in the owner's private chat, or a member's own with Personal assistant on
(members' schedules), within what Nocheh runs (ADR-0266). A member's turn binds how many schedules they may keep.

The turn writes the chat's own Hermes schedule store, mounted into the sealed turn, and then reports each schedule it set,
changed or removed to Nocheh from inside the turn, with the turn's pass (ADR-0290): Nocheh records it for this turn's
person and chat, or refuses it, and only a schedule it recorded ever runs. Nocheh's scheduler fires it as a sealed turn
and sends its result to this chat. Hermes's pre_tool_call hook keeps the tool to what that runs: an agent prompt on a
schedule, sent back here, in the time zone the owner named or else their own. Everything else Hermes's tool can do
(scripts, other models, webhooks, running a schedule inside this reply) is refused, and its notes about Hermes's own
gateway, which Nocheh does not run, are replaced by what Nocheh does.
The hooks are inert, and the tool refused, unless the turn bound them.
"""
import json
import threading
from pathlib import Path
from zoneinfo import ZoneInfo,available_timezones

TOOL='cronjob_manage'
ACTIONS={'create','list','update','pause','resume','remove'}
# Arguments the tool may carry. Every other argument is refused unless it is empty.
ARGUMENTS={'action','job_id','prompt','schedule','name','repeat','include_disabled','reason','deliver','timezone','paused'}
EMPTY=(None,'',False,[],{})
RUN_REFUSED=("Nocheh runs each schedule at its own time and sends the result to this chat; it cannot run one inside this "
             "reply. To change when it runs, update its schedule.")
OPTION_REFUSED="Nocheh runs a schedule only as a prompt on its schedule, sent to this chat. Leave out: {names}."
UNBOUND="Schedules can be set only from the owner's own message in their private chat, or a member's own in theirs."
ZONE_REFUSED="{zone} is not a time zone name. Use one such as Europe/Berlin, or leave it out for the owner's own."
LIMIT="This chat already has {count} schedules, the most allowed. Remove one first."
# What a schedule Nocheh did not record says instead of its note: it stays in the store but never runs.
LIMIT_NOW="This chat already has the most schedules allowed. Remove one first."
NOT_SAVED="Nocheh did not save this schedule, so it will not run. Try again in a new message."
NOT_SAVED_CHANGE=("Nocheh did not save this change, so this schedule does not run, as it was or as changed, until it is set "
                  "again in a new message. The Schedules page shows it as not running.")
# A post whose answer was lost: Nocheh may still have saved it, and Nocheh's scheduler finds out by itself.
UNCONFIRMED=("Nocheh has not confirmed this schedule yet. It runs only if Nocheh saved it; the Schedules page shows whether "
             "it did. Do not set it again now.")
NOTE=("Nocheh runs this at its time as a fresh reply with this chat's tools and memory, and sends the result to this chat. "
      "A run with nothing worth sending should answer only [SILENT]. The owner sees and manages schedules on the "
      "dashboard's Schedules page and in the mini app.")
# A member's own schedules (members' schedules): they see and manage them in the members' app; the owner sees them too.
MEMBER_NOTE=("Nocheh runs this at its time as a fresh reply in this chat, reading only what this chat reads, and sends the "
             "result to this chat. A run with nothing worth sending should answer only [SILENT]. The member sees and manages "
             "their schedules in the members' app, and the owner sees them too.")
# What a result keeps: Hermes's own warnings speak of its gateway and its delivery targets, which Nocheh replaces.
KEPT={'success','error','job_id','name','schedule','repeat','next_run_at','count','jobs','removed_job','job'}

_LOCK=threading.Lock()
_BOUND=None


def bind(time_zone,limit=None,count=None,profile=None,scope=None,home=None):
    """Bind this turn's schedule rules once: the owner's time zone and, for a member (step 3), how many they may keep;
    and where its schedules are recorded: the chat's schedule store (home), its logical profile and chat (scope)."""
    global _BOUND
    with _LOCK:
        if _BOUND is not None:raise RuntimeError('schedule_gate_already_bound')
        if not isinstance(time_zone,str) or not 0<len(time_zone)<=64:raise ValueError('invalid_schedule_time_zone')
        _BOUND={'time_zone':time_zone,'limit':limit,'count':count,'profile':profile,'scope':scope,
                'home':Path(home) if home is not None else None,'removing':{}}


def bound():
    return _BOUND is not None


def tool_call(tool_name='',args=None,**_):
    """pre_tool_call, fail closed: a schedule call that is not plainly allowed is refused."""
    if tool_name!=TOOL:return None
    try:
        rules=_BOUND
        if rules is None:return {'action':'block','message':UNBOUND}
        args=args if isinstance(args,dict) else {}
        action=str(args.get('action') or '').strip().lower()
        if action in ('run','trigger','cancel'):return {'action':'block','message':RUN_REFUSED}
        if action not in ACTIONS:return {'action':'block','message':'Use one of: '+', '.join(sorted(ACTIONS))+'.'}
        extra=sorted(key for key,value in args.items() if key not in ARGUMENTS and value not in EMPTY)
        if args.get('paused') not in EMPTY:extra.append('paused')
        if extra:return {'action':'block','message':OPTION_REFUSED.format(names=', '.join(extra))}
        if action=='create' and rules['limit'] is not None and isinstance(rules['count'],int) and rules['count']>=rules['limit']:
            return {'action':'block','message':LIMIT.format(count=rules['count'])}
        if action=='remove':_remember(args.get('job_id'))
        if action in ('create','update'):
            # Results come back to this chat (Nocheh's "telegram" delivery). A zone the owner named is kept; a new
            # schedule without one, or a cleared one, takes the owner's own. An update that names none keeps its zone.
            changes={'deliver':'telegram'}
            zone=args.get('timezone')
            if zone not in EMPTY:
                if not _zone(zone):return {'action':'block','message':ZONE_REFUSED.format(zone=str(zone)[:64])}
            elif action=='create' or zone=='':
                changes['timezone']=rules['time_zone']
            return {'action':'modify','args':changes}
        return None
    except Exception:
        return {'action':'block','message':UNBOUND}


def _zone(value):
    """Whether value names an IANA time zone this machine knows."""
    if not isinstance(value,str) or not 0<len(value)<=64 or value not in available_timezones():return False
    try:ZoneInfo(value)
    except Exception:return False
    return True


def _remember(ref):
    """Keep a copy of the job a remove names, as Hermes resolves it (its id, else its one name), so the removal can be
    reported once the job is gone from the store. Never blocks the call."""
    try:
        if _BOUND['home'] is None or not isinstance(ref,str) or not ref:return
        from .native_cron import inspect
        jobs=inspect(_BOUND['home'])
        found=[job for job in jobs if job.get('id')==ref] or [job for job in jobs if (job.get('name') or '').lower()==ref.lower()]
        if len(found)==1:_BOUND['removing'][found[0]['id']]=found[0]
    except Exception:pass


def _record(action,value,args):
    """Report what the tool did to Nocheh from inside this turn. Returns the refusal's message, or None when recorded."""
    from . import native_cron
    from .archive_tools import request
    rules=_BOUND
    if action=='remove':
        removed=value.get('removed_job') if isinstance(value.get('removed_job'),dict) else {}
        job=rules['removing'].pop(removed.get('id'),None)
        # A removal Nocheh missed only leaves its row waiting; the job is gone either way. One Nocheh recorded once and a
        # later refused change left inert still has its row there, so its removal is reported too.
        if job and (job.get('nocheh_registered') or job.get('nocheh_synced_revision')):
            try:native_cron.turn_remove(job,rules['profile'],rules['scope'],request)
            except Exception:pass
        return None
    job=value.get('job') if isinstance(value.get('job'),dict) else {}
    job_id=value.get('job_id') if isinstance(value.get('job_id'),str) else job.get('job_id') if isinstance(job.get('job_id'),str) else args.get('job_id')
    try:
        if rules['home'] is None or not isinstance(job_id,str):raise ValueError('schedule_turn_unbound')
        native_cron.turn_capture(job_id,rules['home'],rules['profile'],rules['scope'],request)
        return None
    except Exception as error:
        if native_cron.refusal(error)[1]=='schedule_limit_reached':return LIMIT_NOW
        if native_cron.transient(error):return UNCONFIRMED
        return NOT_SAVED if action=='create' else NOT_SAVED_CHANGE


def tool_result(tool_name='',result=None,args=None,**_):
    """transform_tool_result: Nocheh records what the tool set (or says it did not), and its note replaces Hermes's
    notes about its own gateway and delivery."""
    if tool_name!=TOOL or _BOUND is None or not isinstance(result,str):return None
    try:
        value=json.loads(result)
        if not isinstance(value,dict):return None
        kept={key:value[key] for key in KEPT if key in value}
        if value.get('success') is True:
            args=args if isinstance(args,dict) else {}
            action=str(args.get('action') or '').strip().lower()
            refused=_record(action,value,args) if action in ('create','update','pause','resume','remove') else None
            if refused:
                kept['success']=False;kept['error']=refused
                return json.dumps(kept,ensure_ascii=False)
            kept['note']=NOTE if _BOUND['limit'] is None else MEMBER_NOTE
            if isinstance(kept.get('job_id'),str) and _BOUND['count'] is not None:
                with _LOCK:_BOUND['count']+=1
        return json.dumps(kept,ensure_ascii=False)
    except Exception:
        return None
