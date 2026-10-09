"""Extend an owned synthetic installation with actual Telegram HTTP polling.

Reuses the installation's stores, Hermes, Honcho and deterministic inference.
Only Telegram's transport URL changes; no public port or external network opens.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from tools.paths import ROOT
from tools.acceptance.telegram_mock import TOKEN


def validate_fixture(directory,info,manifest):
    if not directory.is_relative_to(ROOT/'data/acceptance/results'):raise ValueError('owned_fixture_directory_required')
    project=info['project']
    if (not re.fullmatch(r'nocheh-installation-[a-f0-9]{12}',project) or manifest['name']!=project
            or Path(info['directory']).resolve()!=directory):raise ValueError('invalid_fixture_project')
    # The optional dashboard preview relay is the only allowed exception: its own
    # network, used by no other service, publishing only on the loopback address.
    preview=manifest['networks'].get('preview')
    if preview is not None:
        relay=manifest['services'].get('fixture-preview',{})
        users=[name for name,service in manifest['services'].items() if 'preview' in (service.get('networks') or {})]
        if (preview!={'name':project+'-preview'} or users!=['fixture-preview'] or set(relay.get('networks') or {})!={'default','preview'}
                or any(port.get('host_ip')!='127.0.0.1' for port in relay.get('ports') or []) or relay.get('volumes')):raise ValueError('isolated_fixture_required')
    networks={key:value for key,value in manifest['networks'].items() if key!='preview'}
    if not networks or any(not value.get('internal') or value.get('external')
            or not value.get('name','').startswith(project) for value in networks.values()):raise ValueError('isolated_fixture_required')
    if any((service.get('ports') and name!='fixture-preview') or service.get('network_mode')=='host'
           for name,service in manifest['services'].items()):raise ValueError('isolated_fixture_required')
    native=manifest['services']['hermes'];provider=manifest['services']['cliproxy-api']
    if native['image']!=info['images']['native'] or provider['environment'].get('NOCHEH_INSTALLATION_FIXTURE')!='1':raise ValueError('synthetic_fixture_required')
    homes=[v for v in native['volumes'] if v.get('target')=='/workspace/data/local/hermes']
    if len(homes)!=1 or homes[0].get('type')!='bind' or Path(homes[0]['source']).resolve()!=directory/'state/hermes':raise ValueError('owned_native_state_required')
    return project


def archived_delivery(query,message,update_id):
    chat=int(message['chat']['id']);number=int(message['message_id']);update_id=int(update_id)
    raw=query('nocheh_archive',"SELECT json_build_object('id',id,'text',convert_from(original_text,'UTF8')) FROM events "
        +"WHERE kind='telegram_delivered_message' AND bot_id='123456' AND scope='"+str(chat)+"' AND source_id='"+str(number)+"'")
    if not raw:return False
    stored=json.loads(raw)
    assert stored['text']==message['text'],'delivered original text differs from Bot API response'
    prefix='outbound:123456:telegram:123456:update:'+str(update_id)+':sendMessage:'
    return query('nocheh_control',"SELECT count(*) FROM content_operations o JOIN capture_effect_receipts r ON r.operation_id=o.id "
        +"WHERE o.kind='outbound_result' AND r.state='delivered' AND o.operation_key LIKE '"+prefix+"%' "
        +"AND r.sources @> '[{\"id\":\""+stored['id']+"\"}]'::jsonb")=='1'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--verify-only',action='store_true')
    parser.add_argument('--scenario',choices=('ordinary','faults-and-files'),default='ordinary');args=parser.parse_args()
    directory=args.directory.resolve()
    if not directory.is_relative_to(ROOT/'data/acceptance/results'):raise ValueError('owned_fixture_directory_required')
    info=json.loads((directory/'fixture.json').read_text());manifest=json.loads((directory/'compose.json').read_text())
    project=validate_fixture(directory,info,manifest)
    command=['docker','compose','-p',project,'-f',str(directory/'compose.json')]
    def run(*args,**kwargs):return subprocess.run(command+list(args),check=True,**kwargs)
    def query(database,sql):return subprocess.check_output(command+['exec','-T','nocheh-db','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','nocheh','-d',database,'-c',sql],text=True).strip()
    assert query('nocheh_control',"SELECT current_setting('cluster_name')")=='nocheh-installation-fixture'
    def http(path,body=None,service='cliproxy-api',port=8317):
        script="""const [service,port,path,encoded]=process.argv.slice(1),body=JSON.parse(encoded);
const response=await fetch('http://'+service+':'+port+path,{method:body===null?'GET':'POST',
headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.SERVICE_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('fixture_http_'+response.status);console.log(JSON.stringify(await response.json()));"""
        return json.loads(subprocess.check_output(command+['exec','-T','nocheh-app','node','--input-type=module','-e',script,service,str(port),path,json.dumps(body)],text=True))
    report_directory=directory/('telegram-http-'+str(time.time_ns()));report_directory.mkdir(mode=0o700)
    state_path=directory/'state/telegram/telegram.json'
    prior_unknown=json.loads(state_path.read_text())['unknown'] if state_path.exists() else []
    gates=[]
    def wait(label,check,seconds=300):
        started=time.monotonic()
        while time.monotonic()-started<seconds:
            result=check()
            if result:
                row={'gate':label,'passed':True,'seconds':round(time.monotonic()-started,3)};gates.append(row)
                (report_directory/'progress.json').write_text(json.dumps(gates,indent=2)+'\n');print(json.dumps(row),flush=True)
                return result
            time.sleep(2)
        raise AssertionError('fixture_gate_timeout:'+label)
    try:
        if not args.verify_only:
            # Preserve the exact previous executable manifest before changing
            # only this fixture's provider and Telegram parent process.
            (report_directory/'compose.before.json').write_text(json.dumps(manifest))
            provider=manifest['services']['cliproxy-api'];native=manifest['services']['hermes']
            provider['environment']['NOCHEH_TELEGRAM_FIXTURE_STATE']='/fixture-state/telegram.json'
            state=directory/'state/telegram';state.mkdir(exist_ok=True,mode=0o700)
            def mount(service,source,target,readonly=True):
                service['volumes']=[value for value in service['volumes'] if value.get('target')!=target]
                service['volumes'].append({'type':'bind','source':str(source),'target':target,'read_only':readonly})
            mount(provider,state,'/fixture-state',False)
            mount(provider,ROOT/'tools/__init__.py','/fixture/tools/__init__.py')
            mount(provider,ROOT/'tools/acceptance/telegram_mock.py','/fixture/tools/acceptance/telegram_mock.py')
            for name in ('telegram_runtime.py','telegram_mock.py'):
                mount(native,ROOT/'tools/acceptance'/name,'/workspace/tools/acceptance/'+name)
            native['command']=['python','-m','tools.acceptance.telegram_runtime']
            native['environment'].update(TELEGRAM_ENABLED='true',TELEGRAM_BOT_TOKEN=TOKEN,NOCHEH_INSTALLATION_FIXTURE='1')
            # The credential-free cached image can have a different built-in
            # UID from this fixture's host UID. Use upstream's explicit lock
            # directory, owned by this installation, instead of Path.home().
            native['environment']['HERMES_GATEWAY_LOCK_DIR']='/workspace/data/local/hermes/gateway-locks'
            native['environment']['HERMES_TELEGRAM_DISABLE_FALLBACK_IPS']='1'
            for path in (directory/'compose.json',directory/'installation/docker-compose.yml'):
                path.write_text(json.dumps(manifest));path.chmod(0o600)
            run('config','--quiet')
            run('stop','-t','120','hermes')
            prior_unknown=json.loads(state_path.read_text())['unknown'] if state_path.exists() else []
            run('up','-d','--no-build','--no-deps','--force-recreate','--wait','cliproxy-api')
            run('up','-d','--no-build','--no-deps','--force-recreate','--wait','hermes')
        wait('native_polling_connected',lambda:http('/health',service='hermes',port=8781)['telegram']=='connected',120)
        initial=http('/fixture/telegram');sent_before=len(initial['sent']);base=int(time.time())
        assert not initial['faults'],'previous fixture faults remain pending'
        probes=[('owner_private',123,None),('named_topic',-10042,7),('general_topic',-10042,None)]
        if args.scenario=='faults-and-files':probes=[('rate_limited_topic',-10042,7),('file_retry',123,None)]
        for index,(label,chat,topic) in enumerate(probes):
            number=base+index;text='سلام، یک جواب کوتاه بده.'
            if chat<0:text='@synthetic_fixture_bot '+text
            message={'message_id':number,'date':base,'chat':{'id':chat,'type':'private' if chat>0 else 'supergroup'},
                'from':{'id':123,'is_bot':False,'first_name':'Synthetic Owner'},'text':text}
            if chat<0:message['chat'].update(title='Synthetic Forum',is_forum=True);message['entities']=[{'type':'mention','offset':0,'length':len('@synthetic_fixture_bot')}]
            if topic is not None:message.update(message_thread_id=topic,is_topic_message=True)
            if label=='rate_limited_topic':
                http('/fixture/telegram/control',{'faults':[{'method':'sendMessage','code':429,
                    'description':'Too Many Requests: retry after 2','parameters':{'retry_after':2}}]})
            if label=='file_retry':
                content=b'\x00synthetic-file\xff\nfixture-secret-ORCHID-2718\n'
                file_id='document-'+str(number)
                metadata={'file_id':file_id,'file_unique_id':'unique-'+str(number),'file_size':len(content)}
                http('/fixture/telegram/control',{'files':[{**metadata,'file_path':'documents/'+file_id+'.bin',
                    'bytes_base64':base64.b64encode(content).decode()}],'faults':[{'method':'getFile','code':503,
                    'description':'Internal Server Error: synthetic file outage'}]})
                message.pop('text');message['caption']=text
                message['document']={**metadata,'file_name':'synthetic.bin','mime_type':'application/octet-stream'}
            http('/fixture/telegram',{'updates':[{'update_id':number,'message':message}]})
            event_id=wait(label+'_captured',lambda:query('nocheh_archive',"SELECT id FROM events WHERE kind='telegram_update' AND source_id='"+str(number)+"' AND scope='"+str(chat)+"'"))
            if label=='file_retry':
                wait('file_retry_completed',lambda:query('nocheh_control',"SELECT count(*) FROM attachment_retrievals WHERE event_id='"+event_id+"' AND state='done' AND attempts=2")=='1')
                expected=hashlib.sha256(content).hexdigest()
                assert query('nocheh_archive',"SELECT file_hash FROM artifacts WHERE event_id='"+event_id+"'")==expected
                assert (directory/'state/files'/expected).read_bytes()==content,'original file bytes changed'
            def done():
                raw=query('nocheh_control',"SELECT json_build_object('state',state,'attempts',attempts,'error',error_code) FROM dispatches WHERE event_id='"+event_id+"'")
                if not raw:return False
                row=json.loads(raw)
                if row['state'] in ('failed','ambiguous','cancelled','suppressed'):raise AssertionError('fixture_dispatch_failed:'+str(row['error']))
                return row if row['state']=='done' else False
            completed=wait(label+'_replied',done);assert completed['attempts']==1
            sent=http('/fixture/telegram')['sent'];new=sent[sent_before:]
            assert len(new)==1,'short fixture turn must deliver once'
            assert new[0]['message']['chat']['id']==chat and new[0]['message'].get('message_thread_id')==topic
            assert '[mock]' in new[0]['message']['text']
            wait(label+'_delivery_archived',lambda:archived_delivery(query,new[0]['message'],number),60)
            if label=='rate_limited_topic':
                def rate_receipts():
                    calls=[row for row in http('/fixture/telegram')['calls'] if row['method']=='sendMessage'
                        and json.loads(row['parameters'].get('reply_parameters','{}')).get('message_id')==number]
                    assert [row.get('status') for row in calls]==[429,200],'rate limit did not produce exactly one safe retry'
                    assert calls[1]['at']-calls[0]['at']>=2,'retry_after was not honored'
                    assert all(int(row['parameters']['chat_id'])==chat and int(row['parameters']['message_thread_id'])==topic for row in calls)
                    return query('nocheh_control',"SELECT count(*) FROM content_operations o JOIN capture_effect_receipts r ON r.operation_id=o.id "
                        +"WHERE o.kind='outbound_result' AND r.state IN ('rejected','delivered') AND o.operation_key LIKE 'outbound:123456:telegram:123456:update:"+str(number)+":sendMessage:%'")=='2'
                wait('rate_limit_wait_and_durable_receipts',rate_receipts,60)
            sent_before=len(sent)
        number=base+len(probes)
        denied={'update_id':number,'message':{'message_id':number,'date':base,'chat':{'id':456,'type':'private'},
            'from':{'id':456,'is_bot':False,'first_name':'Unselected'},'text':'Unselected synthetic private message'}}
        http('/fixture/telegram',{'updates':[denied]})
        denied_id=wait('unselected_private_captured',lambda:query('nocheh_archive',"SELECT id FROM events WHERE kind='telegram_update' AND source_id='"+str(number)+"' AND scope='456'"))
        wait('unselected_private_silent',lambda:query('nocheh_control',"SELECT count(*) FROM dispatches WHERE event_id='"+denied_id+"' AND state='suppressed' AND attempts=0")=='1')
        before=http('/fixture/telegram');assert len(before['sent'])==sent_before
        assert before['unknown']==prior_unknown,before['unknown'][len(prior_unknown):]
        assert any('message_reaction' in row['parameters'].get('allowed_updates',[]) for row in before['calls'] if row['method']=='getUpdates')
        # PTB resets its requested offset on a new process. Acknowledgement
        # must be observed before restart; an empty durable server queue and
        # unchanged sends then prove that restart did not resurrect updates.
        wait('confirmed_updates_acknowledged',lambda:http('/fixture/telegram')['offset']>number,60)
        run('restart','--no-deps','hermes')
        run('up','-d','--no-build','--no-deps','--wait','hermes')
        wait('polling_reconnected',lambda:http('/health',service='hermes',port=8781)['telegram']=='connected',120)
        after=http('/fixture/telegram');assert len(after['sent'])==sent_before and after['unknown']==prior_unknown
        assert not after['updates'],'acknowledged updates reappeared after restart'
        assert not after['faults'],'fixture fault was not exercised'
        stats=http('/fixture/stats');assert stats['chat']>0 and stats['raw_canary_outside_detector']==0
        (report_directory/'result.json').write_text(json.dumps({'passed':True,'live_acceptance':False,'scenario':args.scenario,'gates':gates,
            'new_replies':len(after['sent'])-len(initial['sent']),'unknown_methods':after['unknown'][len(prior_unknown):],
            'prior_unknown_methods':prior_unknown,'stats':stats},indent=2)+'\n')
        print(json.dumps({'passed':True,'report':str(report_directory/'result.json')}),flush=True)
    except Exception as error:
        (report_directory/'failure.json').write_text(json.dumps({'passed':False,'type':type(error).__name__,
            'code':str(error) if isinstance(error,AssertionError) else 'fixture_operation_failed','gates':gates},indent=2)+'\n')
        raise


if __name__=='__main__':main()
