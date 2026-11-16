"""Extend an owned synthetic installation with actual Telegram HTTP polling.

Reuses the installation's stores, Telegram service, Hermes, Honcho and deterministic
inference. Only the Telegram service's Bot API address changes; no public port or
external network opens.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from tools.paths import ROOT
from tools.acceptance.telegram_mock import TOKEN,bot_status,press

# The real-model rehearsal's only egress, attached to the model relay alone.
MODEL_EGRESS='model-egress'
# Nocheh's own Telegram service holds the bot token, polls, sends and reports the
# Telegram state on its health; Hermes keeps only the brain.
TELEGRAM_SERVICE='nocheh-telegram'
TELEGRAM_HEALTH='http://nocheh-telegram:8784/health'
# The service's folders that must be this fixture's: its incident file and the capture spool.
TELEGRAM_STATE={'/telegram-state':'state/telegram','/data/spool':'state/spool'}
# The synthetic owner, and the groups the owner adds Nocheh to before anything else (telegram_scenarios: GROUP,
# OTHER_GROUP and THIRD_GROUP). Only the owner adds Nocheh to a group (ADR-0253).
OWNER=123
GROUPS=(-10042,-10043,-10044)


def group_chat(chat):
    """A fixture group as its messages show it (telegram_scenarios.Fixture.message)."""
    return {'id':chat,'type':'supergroup','title':'Synthetic Forum '+str(chat),'is_forum':True}


def person(user):
    return {'id':user,'is_bot':False,'first_name':'Synthetic '+str(user)}


def served(query,chat):
    """Whether Nocheh is on in a group: its chat is active, by any Telegram id it has had (ADR-0253)."""
    return query('nocheh_control',"SELECT count(*) FROM chats c JOIN chat_ids i ON i.chat_id=c.id WHERE i.external_id='"+str(int(chat))
                 +"' AND c.kind='group' AND c.state='active'")=='1'


def sent_buttons(row):
    """The inline buttons a message was sent with, which an edit may since have removed."""
    markup=row['parameters'].get('reply_markup') or {}
    markup=json.loads(markup) if isinstance(markup,str) else markup
    return [button for line in markup.get('inline_keyboard') or [] for button in line]


def add_card(sent,event_id,owner=OWNER):
    """The card Nocheh sends the owner after they add it to a group: every button names the add's event (ADR-0253)."""
    return next((row for row in sent if row['message']['chat']['id']==owner and sent_buttons(row) and all(
        re.fullmatch('ng[012xo]'+event_id[:32],str(button.get('callback_data') or '')) for button in sent_buttons(row))),None)


def adopt(http,query,wait,number,chats=GROUPS,owner=OWNER):
    """The owner adds Nocheh to each group (Telegram's my_chat_member, from the owner): it is on there at once. The card
    it sends the owner about 30 seconds later is answered No project, so each group starts on and in no project. A group
    already on is left as it is. Returns the next unused update number."""
    added={}
    for chat in chats:
        if served(query,chat):continue
        update=bot_status(number,group_chat(chat),person(owner));number+=1
        http('/fixture/telegram',{'updates':[update]});added[chat]=update['update_id']
    for chat,update_id in added.items():
        label=str(chat).replace('-','minus')
        event_id=wait('owner_add_captured_'+label,lambda update_id=update_id:query('nocheh_archive',"SELECT id FROM events WHERE kind='telegram_update' AND "
                      "(convert_from(payload,'UTF8')::jsonb->>'update_id')='"+str(update_id)+"'"))
        wait('on_at_once_'+label,lambda chat=chat:served(query,chat),60)
        card=wait('add_card_'+label,lambda event_id=event_id:add_card(http('/fixture/telegram')['sent'],event_id,owner),180)
        data=next(button['callback_data'] for button in sent_buttons(card) if button['callback_data'].startswith('ngx'))
        tap=press(number,card['message'],data,person(owner));number+=1
        http('/fixture/telegram',{'updates':[tap]})
        def answered(card=card,tap=tap):
            state=http('/fixture/telegram')
            shown=next(row for row in state['sent'] if row['message']['chat']['id']==owner and row['message']['message_id']==card['message']['message_id'])
            return any(row['callback_query_id']==tap['callback_query']['id'] for row in state.get('answers',[])) and shown.get('edits') and not shown['message'].get('reply_markup')
        wait('add_card_answered_no_project_'+label,answered,120)
        wait('still_on_'+label,lambda chat=chat:served(query,chat),30)
    return number


def telegram_health(command):
    """The Telegram service's health, read from inside nocheh-app: the fixture publishes no port."""
    script="""const response=await fetch(process.argv[1],{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('telegram_health_'+response.status);console.log(JSON.stringify(await response.json()));"""
    return json.loads(subprocess.check_output(command+['exec','-T','nocheh-app','node','--input-type=module','-e',script,TELEGRAM_HEALTH],text=True))


def wait_telegram_connected(wait,command,label,seconds=120):
    """Wait, through the caller's own wait(label,check,seconds), until the service polls the fake Bot API."""
    return wait(label,lambda:telegram_health(command)['telegram']=='connected',seconds)


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
    egress=manifest['networks'].get(MODEL_EGRESS)
    if egress is not None:
        users=[name for name,service in manifest['services'].items() if MODEL_EGRESS in (service.get('networks') or {})]
        if egress!={'name':project+'-'+MODEL_EGRESS} or users!=['model-fixture']:raise ValueError('isolated_fixture_required')
    networks={key:value for key,value in manifest['networks'].items() if key not in ('preview',MODEL_EGRESS)}
    if not networks or any(not value.get('internal') or value.get('external')
            or not value.get('name','').startswith(project) for value in networks.values()):raise ValueError('isolated_fixture_required')
    if any((service.get('ports') and name!='fixture-preview') or service.get('network_mode')=='host'
           for name,service in manifest['services'].items()):raise ValueError('isolated_fixture_required')
    native=manifest['services']['hermes'];bot=manifest['services'][TELEGRAM_SERVICE];provider=manifest['services']['model-fixture']
    if (native['image']!=info['images']['native'] or bot['image']!=info['images']['native']
            or provider['environment'].get('NOCHEH_INSTALLATION_FIXTURE')!='1'):raise ValueError('synthetic_fixture_required')
    owned=[(native,'/workspace/data/local/hermes','state/hermes')]+[(bot,target,source) for target,source in TELEGRAM_STATE.items()]
    for service,target,source in owned:
        mounts=[v for v in service['volumes'] if v.get('target')==target]
        if len(mounts)!=1 or mounts[0].get('type')!='bind' or Path(mounts[0]['source']).resolve()!=directory/source:raise ValueError('owned_native_state_required')
    # Only the Telegram service may hold the bot token: a second holder could poll beside it.
    if any(key.startswith('TELEGRAM_BOT_TOKEN') for key in native.get('environment') or {}):raise ValueError('telegram_token_outside_telegram_service')
    return project


def archived_delivery(query,message,update_id):
    chat=int(message['chat']['id']);number=int(message['message_id']);update_id=int(update_id)
    # A fixture whose Bot API state was restored can repeat a message number,
    # so the delivery is the archived record carrying exactly this reply's text.
    raw=query('nocheh_archive',"SELECT json_agg(json_build_object('id',id,'text',convert_from(original_text,'UTF8')) ORDER BY received_at) FROM events "
        +"WHERE kind='telegram_delivered_message' AND bot_id='123456' AND scope='"+str(chat)+"' AND source_id='"+str(number)+"'")
    rows=json.loads(raw) if raw else None
    if not rows:return False
    matching=[row for row in rows if row['text']==message['text']]
    assert matching,'delivered original text differs from Bot API response'
    stored=matching[-1]
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
    def http(path,body=None,service='model-fixture',port=8317):
        script="""const [service,port,path,encoded]=process.argv.slice(1),body=JSON.parse(encoded);
const response=await fetch('http://'+service+':'+port+path,{method:body===null?'GET':'POST',
headers:{'content-type':'application/json',Authorization:'Bearer '+process.env.SERVICE_TOKEN},
...(body===null?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('fixture_http_'+response.status);console.log(JSON.stringify(await response.json()));"""
        return json.loads(subprocess.check_output(command+['exec','-T','nocheh-app','node','--input-type=module','-e',script,service,str(port),path,json.dumps(body)],text=True))
    report_directory=directory/('telegram-http-'+str(time.time_ns()));report_directory.mkdir(mode=0o700)
    # The fake's own folder: state/telegram belongs to the Telegram service.
    state_path=directory/'state/telegram-mock/telegram.json'
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
            # only this fixture's provider, Telegram service and Hermes's Telegram scopes.
            (report_directory/'compose.before.json').write_text(json.dumps(manifest))
            provider=manifest['services']['model-fixture'];bot=manifest['services'][TELEGRAM_SERVICE]
            # Hermes answers Telegram turns only with Telegram enabled; it never gets the token.
            manifest['services']['hermes']['environment']['TELEGRAM_ENABLED']='true'
            provider['environment']['NOCHEH_TELEGRAM_FIXTURE_STATE']='/fixture-state/telegram.json'
            # The fake Telegram keeps its state in a folder only this host user
            # can open; on Linux root without capabilities cannot read it.
            provider['user']=str(os.getuid())+':'+str(os.getgid())
            state=state_path.parent;state.mkdir(exist_ok=True,mode=0o700)
            def mount(service,source,target,readonly=True):
                service['volumes']=[value for value in service['volumes'] if value.get('target')!=target]
                service['volumes'].append({'type':'bind','source':str(source),'target':target,'read_only':readonly})
            mount(provider,state,'/fixture-state',False)
            mount(provider,ROOT/'tools/__init__.py','/fixture/tools/__init__.py')
            mount(provider,ROOT/'tools/acceptance/telegram_mock.py','/fixture/tools/acceptance/telegram_mock.py')
            for name in ('telegram_runtime.py','telegram_mock.py'):
                mount(bot,ROOT/'tools/acceptance'/name,'/workspace/tools/acceptance/'+name)
            bot['command']=['python','-m','tools.acceptance.telegram_runtime']
            bot['environment'].update(TELEGRAM_ENABLED='true',TELEGRAM_BOT_TOKEN=TOKEN,NOCHEH_INSTALLATION_FIXTURE='1')
            for path in (directory/'compose.json',directory/'installation/docker-compose.yml'):
                path.write_text(json.dumps(manifest));path.chmod(0o600)
            run('config','--quiet')
            run('stop','-t','60',TELEGRAM_SERVICE)
            prior_unknown=json.loads(state_path.read_text())['unknown'] if state_path.exists() else []
            run('up','-d','--no-build','--no-deps','--force-recreate','--wait','model-fixture')
            run('up','-d','--no-build','--no-deps','--force-recreate','--wait','hermes')
            run('up','-d','--no-build','--no-deps','--force-recreate','--wait',TELEGRAM_SERVICE)
        wait_telegram_connected(wait,command,'telegram_polling_connected')
        initial=http('/fixture/telegram')
        assert not initial['faults'],'previous fixture faults remain pending'
        # Without an explicit list Telegram leaves out reactions; with one, it sends only what is listed. An add is one
        # of those updates (my_chat_member), so the service must ask for it.
        assert any('my_chat_member' in row['parameters'].get('allowed_updates',[]) for row in initial['calls'] if row['method']=='getUpdates')
        # The groups the scenarios use, each added by the owner, before any probe there; the card each add brings is
        # answered here, so the probes below count only their own replies.
        base=adopt(http,query,wait,max(int(time.time()),initial.get('last_update_id',0)+1,initial['offset']))
        sent_before=len(http('/fixture/telegram')['sent'])
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
        wait('unselected_private_not_allowed',lambda:query('nocheh_control',"SELECT count(*) FROM dispatches WHERE event_id='"+denied_id+"' AND state='suppressed' AND error_code='not_allowed' AND attempts=0")=='1')
        # Someone else writing privately gets only the owner's fixed text, without a turn.
        before=http('/fixture/telegram');new=before['sent'][sent_before:]
        assert len(new)==1 and new[0]['message']['chat']['id']==456 and new[0]['message']['text']=='Sorry, this is a private assistant. It only works for its owner.',new
        sent_before=len(before['sent'])
        assert before['unknown']==prior_unknown,before['unknown'][len(prior_unknown):]
        assert any('message_reaction' in row['parameters'].get('allowed_updates',[]) for row in before['calls'] if row['method']=='getUpdates')
        # PTB resets its requested offset on a new process. Acknowledgement
        # must be observed before restart; an empty durable server queue and
        # unchanged sends then prove that restart did not resurrect updates.
        wait('confirmed_updates_acknowledged',lambda:http('/fixture/telegram')['offset']>number,60)
        run('restart','--no-deps',TELEGRAM_SERVICE)
        run('up','-d','--no-build','--no-deps','--wait',TELEGRAM_SERVICE)
        wait_telegram_connected(wait,command,'polling_reconnected')
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
