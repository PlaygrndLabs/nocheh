"""Offline reset settlement: inspect receipts, never execute or resend effects.

The caller holds the reset journal and PostgreSQL maintenance exclusion. Native,
capture, workflow, tool and refresh owners must already be stopped. Unconfirmed
external effects remain blockers; stopped local computations may be abandoned
without claiming their unknown result succeeded.
"""
import hashlib
import json
import os
import re
from pathlib import Path

from . import reset_files, reset_inventory, reset_protocol, reset_quiescence

HASH = re.compile(r'[a-f0-9]{64}')
LIMIT = 10000


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value,str) else value).hexdigest()


def native_canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()


def receipt(path):
    """Read a bounded, single-link file without following any path symlink."""
    try:
        with reset_files.parent(path) as (parent,name,_):
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    except FileNotFoundError:
        return None
    with os.fdopen(fd,'rb') as source:
        before=reset_protocol.regular(fd)
        if before.st_size>8*1024*1024:raise ValueError('reset_effect_receipt_limit')
        raw=source.read(8*1024*1024+1);after=os.fstat(fd)
        if len(raw)>8*1024*1024 or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):
            raise ValueError('reset_effect_receipt_changed')
        value=json.loads(raw)
        if not isinstance(value,dict):raise ValueError('reset_effect_receipt_invalid')
        return value,digest(raw)


def entries(directory,pattern,maximum=LIMIT):
    try:
        with reset_files.parent(directory) as (fd,name,_):
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:names=sorted(os.listdir(child))
            finally:os.close(child)
    except FileNotFoundError:return []
    if len(names)>maximum:raise ValueError('reset_effect_inventory_limit')
    if any(not re.fullmatch(pattern,name) for name in names):
        raise ValueError('reset_effect_journal_entry_unknown')
    return names


def outbound(state):
    directory=Path(state)/'spool/outbound'
    names=entries(directory,r'[a-f0-9]{64}\.(intent|result)',2*LIMIT)
    names=set(names);by_dispatch={};evidence=[]
    for name in sorted(names):
        if not name.endswith('.intent'):continue
        saved=receipt(directory/name)
        if saved is None:raise ValueError('reset_effect_receipt_changed')
        value,checksum=saved;payload=value.get('payload',{});method=payload.get('method');parameters=payload.get('parameters')
        bot=value.get('bot_id');key=value.get('key')
        if not isinstance(method,str) or not isinstance(parameters,dict) or not isinstance(bot,str) or not isinstance(key,str):
            raise ValueError('reset_effect_intent_invalid')
        prefix='outbound:'+bot+':';suffix=':'+method+':'+digest(native_canonical(parameters))+':intent'
        if not key.startswith(prefix) or not key.endswith(suffix) or digest(key[:-7])+'.intent'!=name:
            raise ValueError('reset_effect_intent_identity_invalid')
        dispatch=key[len(prefix):-len(suffix)];result_name=name[:-7]+'.result'
        saved_result=receipt(directory/result_name)
        outcome='uncertain';result_hash=None
        if saved_result is not None:
            result,result_hash=saved_result
            if result.get('state') not in ('delivered','rejected','ambiguous') or result.get('event',{}).get('payload',{}).get('intent_key')!=key:
                raise ValueError('reset_effect_result_identity_invalid')
            outcome=result['state']
        effect = ('transport_setup' if method == 'deleteWebhook' and
                  parameters == {'drop_pending_updates': False} else 'delivery')
        if effect == 'delivery':
            by_dispatch.setdefault(dispatch,[]).append(outcome)
        evidence.append({'id':name[:-7],'intent_sha256':checksum,'result_sha256':result_hash,
                         'effect':effect,'outcome':outcome})
    if any(name.endswith('.result') and name[:-7]+'.intent' not in names for name in names):
        raise ValueError('reset_effect_orphan_result')
    return by_dispatch,evidence


def rows(query,store,sql):
    values=json.loads(query(store,"SELECT coalesce(json_agg(t),'[]'::json) FROM ("+sql+' LIMIT 10001) t'))
    if not isinstance(values,list) or len(values)>LIMIT:raise ValueError('reset_effect_inventory_limit')
    return values


def snapshot(query,layout):
    if layout not in ('legacy','original-only-v1'):raise ValueError('reset_effect_layout_invalid')
    store='control' if layout=='original-only-v1' else None
    referenced="SELECT w.job_id FROM workflow_registry w JOIN workflow_receipts r ON r.workflow_id=w.id WHERE r.state IN ('started','ambiguous')"
    dispatches=rows(query,store,"SELECT event_id,attempts,state FROM dispatches WHERE state IN ('running','ambiguous') OR event_id IN ("+referenced+") ORDER BY event_id")
    for row in dispatches:
        identifier=row['event_id']
        if not HASH.fullmatch(identifier):raise ValueError('reset_effect_identity_invalid')
        source=rows(query,'archive' if store else None,"SELECT source_key FROM events WHERE id='"+identifier+"'")
        if len(source)!=1:raise ValueError('reset_effect_source_missing')
        row['source_key']=source[0]['source_key']
    action_table='telegram_action_requests' if store else 'action_requests'
    return {'dispatches':dispatches,
        'telegram':rows(query,store,"SELECT id,state FROM "+action_table+" WHERE state IN ('running','ambiguous') OR id IN ("+referenced+") ORDER BY id"),
        'tools':rows(query,store,"SELECT id,kind,state,started_at IS NOT NULL AS started,result_id IS NOT NULL AS recorded_result FROM controlled_actions WHERE state IN ('running','ambiguous') OR id IN ("+referenced+") ORDER BY id"),
        'managed':rows(query,store,"SELECT event_id,state FROM managed_runs WHERE state='running' OR event_id IN ("+referenced+") ORDER BY event_id"),
        'workflows':rows(query,store,"SELECT r.workflow_id,r.step,r.attempt,r.state,w.family,w.job_id FROM workflow_receipts r JOIN workflow_registry w ON w.id=r.workflow_id WHERE r.state IN ('started','ambiguous') ORDER BY r.workflow_id,r.step,r.attempt")}


def evaluate(state,observed):
    dispatches,evidence=outbound(state);resolved={};results=[];blockers=[]
    tools={};tool_evidence=[];directory=Path(state)/'admin/tools/receipts'
    for name in entries(directory,r'[a-f0-9]{64}\.json'):
        saved=receipt(directory/name)
        if saved is None:raise ValueError('reset_effect_receipt_changed')
        value,checksum=saved
        if value.get('id')!=name[:-5] or value.get('state') not in ('done','failed','ambiguous'):
            raise ValueError('reset_effect_tool_receipt_invalid')
        tools[name[:-5]]=saved
        tool_evidence.append({'id':name[:-5],'state':value['state'],'receipt_sha256':checksum})
    known={row['id'] for row in observed['tools']}
    for identifier,(value,_) in tools.items():
        if identifier not in known and value['state']=='ambiguous':
            blockers.append({'kind':'tool','id':identifier,'reason':'orphan_external_outcome_unconfirmed'})
    for row in evidence:
        if row['effect']=='delivery' and row['outcome'] in ('uncertain','ambiguous'):
            blockers.append({'kind':'telegram_delivery','id':row['id'],'reason':'external_outcome_unconfirmed'})
    def add(kind,identifier,outcome,checksum=None):
        if not isinstance(identifier,str) or not HASH.fullmatch(identifier):raise ValueError('reset_effect_identity_invalid')
        resolved[(kind,identifier)]=outcome
        results.append({'kind':kind,'id':identifier,'outcome':outcome,**({'receipt_sha256':checksum} if checksum else {})})
    for kind in ('dispatches','telegram'):
        for row in observed[kind]:
            identifier=row['event_id'] if kind=='dispatches' else row['id']
            if not isinstance(identifier,str) or not HASH.fullmatch(identifier):raise ValueError('reset_effect_identity_invalid')
            if kind=='dispatches':
                if type(row['attempts']) is not int or row['attempts']<0:raise ValueError('reset_effect_attempt_invalid')
                name=digest(identifier+':'+str(row['attempts']));dispatch=row['source_key']
            else:name='action-'+identifier;dispatch='action:'+identifier
            saved=receipt(Path(state)/'spool/dispatch'/(name+'.result'))
            checksum=saved[1] if saved else None
            if saved and saved[0].get('state') not in ('done','failed','ambiguous','suppressed','cancelled','denied'):
                raise ValueError('reset_effect_native_receipt_invalid')
            outcomes=dispatches.get(dispatch,[])
            if any(item in ('uncertain','ambiguous') for item in outcomes):outcome='external_outcome_unconfirmed'
            elif outcomes:outcome='delivery_receipts_reconciled'
            elif row['state'] in ('done','suppressed','cancelled','rejected') or saved and saved[0]['state'] in ('done','suppressed','cancelled','denied'):
                outcome='recorded_terminal'
            else:outcome='stopped_without_delivery_attempt'
            add(kind,identifier,outcome,checksum)
    for row in observed['tools']:
        identifier=row['id']
        if not isinstance(identifier,str) or not HASH.fullmatch(identifier):raise ValueError('reset_effect_identity_invalid')
        if row['kind'] not in ('shell','browser','mcp'):raise ValueError('reset_effect_kind_unknown')
        saved=tools.get(identifier)
        terminal=saved[0]['state'] if saved else row['state']
        if terminal in ('done','failed','rejected'):outcome='recorded_terminal'
        elif not row['started']:outcome='stopped_before_execution'
        elif row['kind']=='shell':outcome='stopped_local_result_unknown'
        else:
            outcome='external_outcome_unconfirmed'
            blockers.append({'kind':'tool','id':identifier,'reason':outcome})
        add('tools',identifier,outcome,saved[1] if saved else None)
    for row in observed['managed']:
        add('managed',row['event_id'],'stopped_local_result_unknown' if row['state']=='running' else 'recorded_terminal')
    for row in observed['workflows']:
        domain={'tools':'tools','actions':'telegram','telegram':'dispatches','browser':'managed'}.get(row['family'])
        outcome=resolved.get((domain,row['job_id']))
        if outcome is None:
            blockers.append({'kind':'workflow','id':row['workflow_id'],'reason':'domain_receipt_unreconciled'})
        add('workflows',row['workflow_id'],outcome or 'domain_receipt_unreconciled')
    return {'settled':not blockers,'results':results,'outbound':evidence,'tool_receipts':tool_evidence,'blockers':blockers,
            'actions_replayed':False,'database_receipts_changed':False}


def settle(journal,preflight,recovery,*,inspect=None):
    """Record the gate only after stable offline reconciliation under exclusion."""
    journal.assert_current()
    if journal.value is None or len(journal.value['steps']) not in (2,3) or journal.value['steps'][1]['step']!='quiesced':
        raise ValueError('reset_effect_phase_required')
    if reset_quiescence.hashlib_preflight(preflight)!=journal.value['preflight_sha256']:
        raise ValueError('reset_preflight_changed')
    inspect=inspect or (lambda:reset_inventory.inspect(journal.state))
    def barrier():
        recovery.assert_maintenance()
        reset_quiescence.verify_quiescent(journal,preflight,inspect())
    barrier();observed=snapshot(recovery.query,preflight['installation']['storage_layout'])
    result=evaluate(journal.state,observed);barrier()
    if observed!=snapshot(recovery.query,preflight['installation']['storage_layout']) or result!=evaluate(journal.state,observed):
        raise RuntimeError('reset_effect_evidence_changed')
    barrier()
    result.update(format='nocheh-reset-settlement-v1',reset_id=journal.value['reset_id'],
                  preflight_sha256=journal.value['preflight_sha256'])
    if not result['settled']:
        reset_protocol.atomic(journal.directory/'unresolved-effects.json',result)
        raise RuntimeError('reset_external_effects_unresolved')
    path=journal.directory/'settlement.json'
    if path.exists() or path.is_symlink():
        if reset_protocol.read(path)!=result:raise RuntimeError('reset_effect_evidence_changed')
    else:reset_protocol.atomic(path,result,create=True)
    barrier();journal.complete('effects_settled',reset_protocol.fingerprint(result))
    return result
