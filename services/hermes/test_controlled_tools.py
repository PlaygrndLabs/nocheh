import json,sys,tempfile,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
from tools.operations.security.tool_execution import public_target,workspace,sandbox_command,mcp_call,execute
from tools.operations.security.tool_receipts import tick,permitted_execute

class ToolTests(unittest.TestCase):
    def test_public_resolver_denies_every_private_candidate_and_pins_public_ip(self):
        for addresses in (['127.0.0.1'],['::1'],['169.254.169.254'],['93.184.216.34','10.0.0.1'],['::ffff:127.0.0.1']):
            with self.assertRaisesRegex(ValueError,'private_destination_denied'):
                public_target('https://example.com',lambda *a,**k:[(None,None,None,None,(ip,443)) for ip in addresses])
        url,ip=public_target('https://example.com/path?q=1',lambda *a,**k:[(None,None,None,None,('93.184.216.34',443))])
        self.assertEqual(ip,'93.184.216.34');self.assertEqual(url.hostname,'example.com')
        for url in ['file:///etc/passwd','https://u:p@example.com','https://example.com:8780','http://example.com']:
            with self.assertRaises(ValueError):public_target(url)

    def test_workspace_mount_has_no_parent_paths_or_credentials_and_browser_has_no_mount(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'hermes/profiles/scoped';home.mkdir(parents=True)
            action={'kind':'shell','profile':'scoped','arguments':{'command':'UNTRUSTED; $(command)'}}
            command=sandbox_command(root,action,'test-only')
            self.assertIn('--network=none',command);self.assertIn('--read-only',command);self.assertIn('--cap-drop=ALL',command)
            self.assertNotIn(action['arguments']['command'],' '.join(command))
            self.assertIn('type=bind,src='+str((home/'workspace').resolve())+',dst=/workspace',command)
            self.assertFalse(any('SERVICE_TOKEN' in x or 'docker.sock' in x for x in command))
            self.assertNotIn('--mount',sandbox_command(root,{**action,'kind':'browser'},'test-only'))
            # Chromium's threads count as processes; a shell command keeps the tighter bound.
            self.assertIn('--pids-limit=512',sandbox_command(root,{**action,'kind':'browser'},'test-only'))
            self.assertIn('--pids-limit=128',command)
            (home/'workspace').rmdir();(home/'workspace').symlink_to(root)
            with self.assertRaisesRegex(ValueError,'workspace_path_denied'):workspace(root,'scoped')
            with self.assertRaisesRegex(ValueError,'profile_denied'):workspace(root,'../private')

    def test_mcp_exact_arguments_no_sampling_and_no_retry(self):
        calls=[]
        def remote(url,body,headers):
            calls.append((url,body,headers))
            if body['method']=='initialize':return json.dumps({'jsonrpc':'2.0','id':1,'result':{'protocolVersion':'2025-11-25'}}).encode(),{'content-type':'application/json','mcp-session-id':'session'}
            if body['method']=='notifications/initialized':return b'',{}
            return json.dumps({'jsonrpc':'2.0','id':2,'result':{'content':[{'type':'text','text':'fixture'}]}}).encode(),{'content-type':'application/json'}
        args={'url':'https://example.com/mcp','tool':'fixture','input':{'exact':'\r\n'}}
        self.assertEqual(mcp_call(args,remote)['response']['content'][0]['text'],'fixture')
        self.assertEqual([call[1]['method'] for call in calls],['initialize','notifications/initialized','tools/call'])
        self.assertEqual(calls[-1][1]['params'],{'name':'fixture','arguments':{'exact':'\r\n'}})
        self.assertEqual(calls[-1][2]['Mcp-Session-Id'],'session')
        def malicious(url,body,headers):return json.dumps({'jsonrpc':'2.0','id':1,'method':'sampling/createMessage'}).encode(),{'content-type':'application/json'}
        with self.assertRaisesRegex(RuntimeError,'mcp_response_rejected'):mcp_call(args,malicious)

    def test_a_tool_that_answers_with_its_own_error_is_recorded_as_failed(self):
        def remote(answer):
            def call(url,body,headers):
                if body['method']=='initialize':return json.dumps({'jsonrpc':'2.0','id':1,'result':{'protocolVersion':'2025-11-25'}}).encode(),{'content-type':'application/json'}
                if body['method']=='notifications/initialized':return b'',{}
                return json.dumps({'jsonrpc':'2.0','id':2,'result':answer}).encode(),{'content-type':'application/json'}
            return call
        refused={'content':[{'type':'text','text':'Invalid made-up property'}],'isError':True}
        args={'url':'https://example.com/mcp','tool':'fixture','input':{}}
        result=mcp_call(args,remote(refused))
        self.assertEqual([result['exit_code'],result['error'],result['response']],[1,'tool_reported_error',refused],'the answer is kept to read')
        self.assertNotIn('exit_code',mcp_call(args,remote({'content':[],'isError':False})))
        self.assertNotIn('exit_code',mcp_call({**args,'operation':'list'},remote({'tools':[],'isError':True})),'only a tool call can fail this way')
        class API:
            def __init__(self):self.finished=None
            def call(self,path,body):
                if path.endswith('/claim'):return {'claimed':True,'id':'a'*64,'kind':'mcp'}
                if path.endswith('/start'):return {'started':True}
                self.finished=body;return {'state':body['state']}
        with tempfile.TemporaryDirectory() as folder:
            api=API();tick(folder,api,'actor',lambda state,action:result,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
        self.assertEqual([api.finished['state'],api.finished['result']['error']],['failed','tool_reported_error'])

    def test_the_settings_check_names_the_chat_profile_not_the_proposal_epoch(self):
        asked=[]
        def native(state,path):
            asked.append(path)
            return {'values':{'nocheh_tools.shell':'off' if 'off' in path else 'on'}}
        action={'kind':'shell','profile':'nocheh-epoch-bound','preference':{'profile':'nocheh-chat','space':'-10/topic/7'},'arguments':{}}
        ready=patch('tools.operations.security.tool_receipts.sandbox_ready',return_value=True);ready.start();self.addCleanup(ready.stop)
        with patch('tools.operations.security.native.call',native),patch('tools.operations.security.tool_receipts.bounded_execute',lambda state,action:{'stdout':'ran'}):
            self.assertEqual(permitted_execute('/state',action),{'stdout':'ran'})
            self.assertEqual(asked,['/api/nocheh/preferences?profile=nocheh-chat&space=-10%2Ftopic%2F7'])
            self.assertEqual(permitted_execute('/state',{**action,'preference':{'profile':'nocheh-off','space':'42'}}),{'exit_code':1,'error':'tool_disabled_by_owner'})
        def down(state,path):raise ValueError('native_administration_unavailable')
        with patch('tools.operations.security.native.call',down),patch('tools.operations.security.tool_receipts.time.sleep') as wait:
            self.assertEqual(permitted_execute('/state',action),{'exit_code':1,'error':'tool_policy_unavailable'})
            self.assertEqual(wait.call_count,2,'it reads the settings three times before it gives up')
        answers=[ValueError('native_administration_unavailable'),{'values':{'nocheh_tools.shell':'on'}}]
        def once(state,path):
            answer=answers.pop(0)
            if isinstance(answer,Exception):raise answer
            return answer
        with patch('tools.operations.security.native.call',once),patch('tools.operations.security.tool_receipts.time.sleep'),\
             patch('tools.operations.security.tool_receipts.bounded_execute',lambda state,action:{'stdout':'ran'}):
            self.assertEqual(permitted_execute('/state',action),{'stdout':'ran'},'a read that fails once, as during a new epoch, is read again')

    def test_a_missing_sandbox_image_stops_before_anything_is_sent(self):
        from tools.operations.security import tool_execution
        asked=[]
        def docker(command,**kwargs):
            asked.append(command);return type('Done',(),{'returncode':1})()
        self.assertFalse(tool_execution.sandbox_ready(docker))
        self.assertEqual(asked,[['docker','image','inspect','--format','{{.Id}}','nocheh-tools:local']])
        self.assertTrue(tool_execution.sandbox_ready(lambda command,**kwargs:type('Done',(),{'returncode':0})()))
        def unreachable(command,**kwargs):raise FileNotFoundError('docker')
        self.assertFalse(tool_execution.sandbox_ready(unreachable),'without Docker there is no sandbox either')
        native=lambda state,path:{'values':{'nocheh_tools.browser':'on','nocheh_tools.mcp':'on'}}
        action={'kind':'browser','profile':'nocheh-chat','preference':{'profile':'nocheh-chat','space':'-10'},'arguments':{'url':'https://example.com/'}}
        def never(*args):raise AssertionError('nothing may be sent without the sandbox')
        with patch('tools.operations.security.native.call',native),patch('tools.operations.security.tool_receipts.sandbox_ready',return_value=False),\
             patch('tools.operations.security.tool_receipts.bounded_execute',never):
            self.assertEqual(permitted_execute('/state',action),{'exit_code':1,'error':'tool_sandbox_missing'})
        with patch('tools.operations.security.native.call',native),patch('tools.operations.security.tool_receipts.sandbox_ready',side_effect=AssertionError('mcp needs no sandbox')),\
             patch('tools.operations.security.tool_receipts.bounded_execute',lambda state,action:{'response':{}}):
            self.assertEqual(permitted_execute('/state',{**action,'kind':'mcp'}),{'response':{}})
        class API:
            def __init__(self):self.finished=None
            def call(self,path,body):
                if path.endswith('/claim'):return {'claimed':True,'id':'a'*64,'kind':'browser'}
                if path.endswith('/start'):return {'started':True}
                self.finished=body;return {'state':body['state']}
        with tempfile.TemporaryDirectory() as folder:
            api=API();tick(folder,api,'actor',lambda state,action:{'exit_code':1,'error':'tool_sandbox_missing'},action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
        self.assertEqual([api.finished['state'],api.finished['result']['error']],['failed','tool_sandbox_missing'])

    def test_the_isolated_helper_reports_only_a_fixed_failure_code(self):
        from tools.operations.security.tool_execution import bounded_execute
        action={'kind':'browser','arguments':{'url':'http://example.com/'}}
        with tempfile.TemporaryDirectory() as folder,patch('tools.operations.security.tool_execution.subprocess.run') as run:
            with self.assertRaises(RuntimeError) as raised:bounded_execute(folder,action)
        self.assertEqual(str(raised.exception),'public_https_required')
        self.assertEqual(run.call_args.args[0][:3],['docker','rm','-f'])

    def test_an_unconfirmed_outcome_keeps_only_a_fixed_failure_code(self):
        from tools.operations.security.tool_execution import failure
        import subprocess,socket,ssl
        self.assertEqual(failure(RuntimeError('browser_html_required')),'browser_html_required')
        self.assertEqual(failure(socket.gaierror('lookup of a private name')),'remote_unreachable')
        self.assertEqual(failure(subprocess.TimeoutExpired(['docker'],50)),'sandbox_timed_out')
        for error in (ConnectionRefusedError(),ssl.SSLError(),TimeoutError()):
            with self.subTest(error=type(error).__name__):self.assertEqual(failure(error),'remote_unreachable')
        self.assertEqual(failure(FileNotFoundError('docker')),'tool_process_failed')
        self.assertEqual(failure(RuntimeError('remote said something private')),'tool_process_failed')
        for raised,cause in ((RuntimeError('sandbox_execution_failed'),'sandbox_execution_failed'),(TimeoutError('tool_deadline'),'tool_deadline'),
                             (RuntimeError('remote said something private'),None),(ValueError('browser_html_required'),None)):
            calls=[]
            class API:
                def call(self,path,body):
                    calls.append((path,body))
                    if path.endswith('/start'):return {'started':True}
                    return {'claimed':True,'id':'f'*64} if path.endswith('/claim') else {}
            def run(*args):raise raised
            with tempfile.TemporaryDirectory() as folder:tick(folder,API(),'actor',run,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
            self.assertEqual(calls[-1][1]['state'],'ambiguous')
            self.assertEqual(calls[-1][1]['result'],{'error':'execution_outcome_unconfirmed',**({'cause':cause} if cause else {})})
            self.assertNotIn('private',json.dumps(calls))

    def test_receipt_outage_does_not_repeat_execution(self):
        class API:
            def __init__(self):self.claims=0;self.finishes=0;self.outage=True
            def call(self,path,body):
                if path.endswith('/start'):return {'started':True}
                if path.endswith('/claim'):
                    self.claims+=1
                    return {'claimed':False} if self.claims>1 else {'claimed':True,'id':'a'*64,'kind':'shell'}
                self.finishes+=1
                if self.outage:raise OSError('archive unavailable')
                return {'state':'done'}
        with tempfile.TemporaryDirectory() as folder:
            api=API();executions=[]
            def run(*args):executions.append(1);return {'text':'done'}
            with self.assertRaises(OSError):tick(folder,api,'actor',run,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
            self.assertEqual(len(list((Path(folder)/'admin/tools/receipts').glob('*.json'))),1)
            api.outage=False;tick(folder,api,'new-actor',run,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
            self.assertEqual(len(executions),1);self.assertEqual(api.finishes,2)
            self.assertEqual(list((Path(folder)/'admin/tools/receipts').glob('*.json')),[])

    def test_executor_timeout_retains_ambiguity_without_exception_content(self):
        calls=[]
        class API:
            def call(self,path,body):
                calls.append((path,body))
                if path.endswith('/start'):return {'started':True}
                return {'claimed':True,'id':'b'*64} if path.endswith('/claim') else {}
        def run(*args):raise TimeoutError('sensitive remote response must not appear')
        with tempfile.TemporaryDirectory() as folder:tick(folder,API(),'actor',run,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
        self.assertEqual(calls[-1][1]['state'],'ambiguous')
        self.assertNotIn('sensitive',json.dumps(calls))

    def test_revoked_authority_after_claim_never_reaches_executor(self):
        calls=[]
        class API:
            def call(self,path,body):
                calls.append((path,body))
                if path.endswith('/claim'):return {'claimed':True,'id':'c'*64}
                if path.endswith('/start'):return {'started':False,'reason':'permission_no_longer_valid'}
                return {}
        def run(*args):raise AssertionError('executor must not run')
        with tempfile.TemporaryDirectory() as folder:tick(folder,API(),'actor',run,action_id='action',workflow={'workflow_id':'workflow','workflow_token':'token'})
        self.assertEqual(calls[-1][1]['state'],'failed')

    def test_targeted_workflow_authority_is_checked_before_start_and_not_stored_in_receipt(self):
        calls=[];action='d'*64;workflow={'workflow_id':'e'*64,'workflow_token':'private-lease-fixture'}
        class API:
            def call(self,path,body):
                calls.append((path,body))
                if path.endswith('/claim'):return {'claimed':True,'id':action}
                if path.endswith('/start'):return {'started':True}
                raise OSError('receipt publication unavailable')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(OSError):tick(folder,API(),'wf-'+workflow['workflow_id'],lambda *_:{'exit_code':0},action_id=action,workflow=workflow)
            self.assertEqual(calls[0][1]['id'],action)
            self.assertEqual(calls[1][1]['workflow_token'],workflow['workflow_token'])
            receipt=(Path(folder)/'admin/tools/receipts'/(action+'.json')).read_text()
            self.assertNotIn('workflow_token',receipt);self.assertNotIn('private-lease',receipt)

    def test_expired_batch_admission_never_claims_a_tool(self):
        class API:
            def call(self,*_):raise AssertionError('no claim after batch admission deadline')
        with tempfile.TemporaryDirectory() as folder:self.assertFalse(tick(folder,API(),'actor',admit=lambda:False))

if __name__=='__main__':unittest.main()
