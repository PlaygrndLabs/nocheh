"""Synthetic live detector quality and native guarded-chat acceptance."""

from integrations.hermes.environment import secret as environment_secret
import json
import os
import time
import urllib.request
from datetime import datetime,timezone
from pathlib import Path


def main():
    if os.environ.get('GUARD_MODE')!='on': raise SystemExit('Run with GUARD_MODE=on for this live check')
    token=environment_secret('SERVICE_TOKEN')
    def call(url,body):
        request=urllib.request.Request(url,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=180) as response: return json.load(response)
    fixtures=[
        ('hey Mak this is Aws pass: 123456','hey Mak this is Aws pass: ***'),
        ('Juniper is due Friday. Contact Mak tomorrow.','Juniper is due Friday. Contact Mak tomorrow.'),
        ('😃\r\nThe password is juniper-ONLY-7642\nمتن اصلی  ','😃\r\nThe password is ***\nمتن اصلی  '),
    ]
    results=[]
    for index,(text,expected) in enumerate(fixtures):
        start=time.monotonic()
        try:
            response=call('http://nocheh-security:8786/v1/guard',{'destination':'https://protected.invalid/responses','payload':{'input':[{'role':'user','content':text}]}})
            actual=response['payload']['input'][0]['content']
            results.append({'fixture':index,'exact_expected_mask':actual==expected,'guarded':response['guarded'],'masked_spans':response['masked_spans']})
        except Exception as error:
            results.append({'fixture':index,'exact_expected_mask':False,'error_type':type(error).__name__})
        results[-1]['duration_ms']=round((time.monotonic()-start)*1000)
        print(json.dumps(results[-1]),flush=True)
    start=time.monotonic()
    try:
        before=call('http://127.0.0.1:8781/internal/status',{})['model_boundary'].get('required',0)
        result=call('http://127.0.0.1:8781/internal/chat',{'text':'The test password is juniper-ONLY-7642. Reply exactly NOCHEH_GUARD_OK and nothing else.'})
        status=call('http://127.0.0.1:8781/internal/status',{})
        required=status['model_boundary'].get('required',0)-before
        chat={'status':'passed' if result['text'].strip()=='NOCHEH_GUARD_OK' and required>0 else 'failed',
              'required_boundary_attempts':required,'guard_failure_codes':status['guard_failures']}
    except Exception as error:
        chat={'status':'failed','error_type':type(error).__name__}
    chat['duration_ms']=round((time.monotonic()-start)*1000);print(json.dumps({'guarded_native_chat':chat}),flush=True)
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'environment':'local-compose','synthetic_inputs_only':True,
            'guard_mode':'on','detector_fixture_results':results,'exact_fixture_matches':sum(r['exact_expected_mask'] for r in results),
            'fixture_count':len(fixtures),'guarded_native_chat':chat,
            'note':'Small synthetic quality sample, not a guarantee of complete secret detection. No requests sent to protected.invalid.'}
    Path('/reports/guard-compatibility.json').write_text(json.dumps(report,indent=2)+'\n')
    return 0 if chat['status']=='passed' and all(r['exact_expected_mask'] for r in results) else 1


if __name__=='__main__':raise SystemExit(main())
