"""Hermes's own schedule tool (cronjob_manage) in the owner's private chat, within what Nocheh runs (ADR-0266).

The turn writes the chat's own Hermes schedule store, mounted into the sealed turn; Nocheh's scheduler captures each new
or changed schedule there before it may run, fires it as a sealed turn and sends its result to this chat. Hermes's
pre_tool_call hook keeps the tool to what that runs: an agent prompt on a schedule, in the owner's time zone, sent back
here. Everything else Hermes's tool can do (scripts, other models, webhooks, running a schedule inside this reply) is
refused, and its notes about Hermes's own gateway, which Nocheh does not run, are replaced by what Nocheh does.
The hooks are inert, and the tool refused, unless the turn bound them.
"""
import json
import threading

TOOL='cronjob_manage'
ACTIONS={'create','list','update','pause','resume','remove'}
# Arguments the tool may carry. Every other argument is refused unless it is empty.
ARGUMENTS={'action','job_id','prompt','schedule','name','repeat','include_disabled','reason','deliver','timezone','paused'}
EMPTY=(None,'',False,[],{})
RUN_REFUSED=("Nocheh runs each schedule at its own time and sends the result to this chat; it cannot run one inside this "
             "reply. To change when it runs, update its schedule.")
OPTION_REFUSED="Nocheh runs a schedule only as a prompt on its schedule, sent to this chat. Leave out: {names}."
UNBOUND="Schedules can be set only from the owner's own message in their private chat."
LIMIT="This chat already has {count} schedules, the most allowed. Remove one first."
NOTE=("Nocheh runs this at its time as a fresh reply with this chat's tools and memory, and sends the result to this chat. "
      "A run with nothing worth sending should answer only [SILENT]. The owner sees and manages schedules on the "
      "dashboard's Schedules page and in the mini app.")
# What a result keeps: Hermes's own warnings speak of its gateway and its delivery targets, which Nocheh replaces.
KEPT={'success','error','job_id','name','schedule','repeat','next_run_at','count','jobs','removed_job','job'}

_LOCK=threading.Lock()
_BOUND=None


def bind(time_zone,limit=None,count=None):
    """Bind this turn's schedule rules once: the owner's time zone and, for a member (step 3), how many they may keep."""
    global _BOUND
    with _LOCK:
        if _BOUND is not None:raise RuntimeError('schedule_gate_already_bound')
        if not isinstance(time_zone,str) or not 0<len(time_zone)<=64:raise ValueError('invalid_schedule_time_zone')
        _BOUND={'time_zone':time_zone,'limit':limit,'count':count}


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
        if action in ('create','update'):
            # Results come back to this chat (Nocheh's "telegram" delivery), in the owner's time zone.
            changes={'deliver':'telegram'}
            if action=='create' or args.get('schedule') not in EMPTY or args.get('timezone') not in EMPTY:
                changes['timezone']=rules['time_zone']
            return {'action':'modify','args':changes}
        return None
    except Exception:
        return {'action':'block','message':UNBOUND}


def tool_result(tool_name='',result=None,**_):
    """transform_tool_result: Nocheh's note instead of Hermes's notes about its own gateway and delivery."""
    if tool_name!=TOOL or _BOUND is None or not isinstance(result,str):return None
    try:
        value=json.loads(result)
        if not isinstance(value,dict):return None
        kept={key:value[key] for key in KEPT if key in value}
        if value.get('success') is True:
            kept['note']=NOTE
            if isinstance(kept.get('job_id'),str) and _BOUND['count'] is not None:
                with _LOCK:_BOUND['count']+=1
        return json.dumps(kept,ensure_ascii=False)
    except Exception:
        return None
