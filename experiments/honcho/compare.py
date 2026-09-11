"""Bounded synthetic recall comparison; retains failures rather than inventing scores."""
import json
import subprocess
import time
import uuid
from datetime import datetime,timezone
from .control import ROOT,STATE,COMPOSE


def score(text,question):
    return {'answer_match':question['answer'].casefold() in text.casefold(),
            'source_match':all(source in text for source in question['sources'])}


def request(base,path,payload=None):
    # Execute inside the isolated network. Internal Docker networks do not offer
    # dependable published-port access on every local engine (including OrbStack).
    targets={'honcho':'http://honcho:8000','meter':'http://127.0.0.1:8790'}
    if base not in targets or not path.startswith('/'): raise ValueError('invalid_experiment_target')
    code="""import json,sys,urllib.request
from pathlib import Path
body=json.load(sys.stdin)
headers={'Content-Type':'application/json','Authorization':'Bearer '+Path('/state/internal_token').read_text().strip()}
req=urllib.request.Request(body['url'],data=None if body['payload'] is None else json.dumps(body['payload']).encode(),headers=headers)
with urllib.request.urlopen(req,timeout=240) as response: print(json.dumps(json.load(response)))
"""
    result=subprocess.run(COMPOSE+['exec','-T','meter','python','-c',code],cwd=ROOT,
        input=json.dumps({'url':targets[base]+path,'payload':payload}),text=True,capture_output=True,timeout=250)
    if result.returncode: raise RuntimeError('experiment_http_failed')
    return json.loads(result.stdout)


def baseline(run_id,prompt):
    result=subprocess.run(COMPOSE+['run','--rm','-T','--no-deps','baseline'],
        input=json.dumps({'run_id':run_id,'prompt':prompt}),capture_output=True,text=True,timeout=240,cwd=ROOT)
    if result.returncode: raise RuntimeError('baseline_process_failed')
    return json.loads(result.stdout)


def main():
    data=json.loads((ROOT/'experiments/honcho/dataset.json').read_text())
    run_id='eval'+uuid.uuid4().hex
    path=STATE/'reports'/f'{run_id}.json'
    report={'run_id':run_id,'recorded_at':datetime.now(timezone.utc).isoformat(),'synthetic_only':True,
            'status':'running','checks':[],'questions':[],'limits':'Exact answer/source-label matching; no LLM judge. Small synthetic dataset is not a production recall estimate.'}
    def save(): path.write_text(json.dumps(report,indent=2)+'\n')
    def check(name,fn):
        start=time.monotonic()
        try: value=fn();row={'name':name,'status':'passed'}
        except Exception as error: value=None;row={'name':name,'status':'failed','error_type':type(error).__name__}
        row['duration_ms']=round((time.monotonic()-start)*1000);report['checks'].append(row);save()
        print(json.dumps(row),flush=True);return value
    def probe():
        result=request('meter','/v1/chat/completions',{
            'model':'gpt-5.6-sol','messages':[{'role':'user','content':'Call record_probe with label READY.'}],
            'tools':[{'type':'function','function':{'name':'record_probe','description':'Record the probe label','parameters':{'type':'object','properties':{'label':{'type':'string'}},'required':['label']}}}],
            'tool_choice':{'type':'function','function':{'name':'record_probe'}},'max_completion_tokens':256})
        calls=result['choices'][0]['message']['tool_calls']
        if calls[0]['function']['name']!='record_probe' or json.loads(calls[0]['function']['arguments']).get('label')!='READY': raise RuntimeError('bridge_tool_call_incompatible')
        return True
    if not check('cliproxy_tool_call',probe):
        report['status']='failed';save();return 1
    sources='\n'.join(f"[{m['source']}] {m['text']}" for m in data['messages'])
    def store_baseline():
        result=baseline(run_id,'Store the following synthetic source facts, including their source labels, using the native memory tool:\n'+sources)
        if result.get('state')!='done': raise RuntimeError('baseline_store_failed')
        memory=STATE/'baseline'/run_id/'memories'
        if not any(p.is_file() and 'fixture:S' in p.read_text() for p in (memory/'MEMORY.md',memory/'USER.md')): raise RuntimeError('native_memory_not_written')
        return True
    baseline_ready=check('hermes_native_store',store_baseline)
    honcho='honcho';workspace='/v3/workspaces/'+run_id
    def seed():
        request(honcho,'/v3/workspaces',{'id':run_id})
        request(honcho,workspace+'/peers',{'id':'fixture-user'})
        request(honcho,workspace+'/sessions',{'id':'source','peers':{'fixture-user':{'observe_me':True,'observe_others':False}}})
        # Never retry this write automatically: a timed-out response may have committed.
        added=request(honcho,workspace+'/sessions/source/messages',{'messages':[
            {'peer_id':'fixture-user','content':f"[{m['source']}] {m['text']}",'metadata':{'source':m['source']}} for m in data['messages']]})
        report['honcho_source_ids']=[{'id':m['id'],'source':m['metadata']['source']} for m in added]
        deadline=time.monotonic()+300
        while time.monotonic()<deadline:
            status=request(honcho,workspace+'/queue/status')
            if status['completed_work_units']>0 and status['pending_work_units']+status['in_progress_work_units']==0:
                report['queue_status']=status;return True
            time.sleep(2)
        report['queue_status']=status;raise RuntimeError('honcho_derivation_timeout')
    honcho_ready=check('honcho_store_and_derive',seed)
    for question in data['questions']:
        prompt=question['query']+' Include the supporting fixture:S source labels; do not invent missing facts.'
        for system,ready in [('hermes',baseline_ready),('honcho',honcho_ready)]:
            row={'system':system,'question':question['id'],'status':'pending' if not ready else 'running'}
            if ready:
                start=time.monotonic()
                try:
                    if system=='hermes':
                        answer=baseline(run_id,prompt)
                        if answer.get('state')!='done': raise RuntimeError('baseline_recall_failed')
                        text=answer['text']
                    else: text=request(honcho,workspace+'/peers/fixture-user/chat',{'query':prompt,'reasoning_level':'low','stream':False})['content'] or ''
                    row.update(status='evaluated',text=text,**score(text,question))
                except Exception as error: row.update(status='failed',error_type=type(error).__name__)
                row['duration_ms']=round((time.monotonic()-start)*1000)
            report['questions'].append(row);save();print(json.dumps({k:v for k,v in row.items() if k!='text'}),flush=True)
    report['ledger']=check('read_persistent_usage',lambda:request('meter','/ledger'))
    report['status']='evaluated' if all(c['status']=='passed' for c in report['checks']) and all(q['status']=='evaluated' for q in report['questions']) else 'incomplete'
    save();print('Report: '+str(path));return 0 if report['status']=='evaluated' else 1
