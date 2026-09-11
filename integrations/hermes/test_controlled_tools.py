import json,sys,tempfile,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
from scripts.tool_execution import public_target,workspace,sandbox_command,mcp_call,execute
from scripts.tool_worker import tick

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
            with self.assertRaises(OSError):tick(folder,api,'actor',run)
            self.assertEqual(len(list((Path(folder)/'admin/tools/receipts').glob('*.json'))),1)
            api.outage=False;tick(folder,api,'new-actor',run)
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
        with tempfile.TemporaryDirectory() as folder:tick(folder,API(),'actor',run)
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
        with tempfile.TemporaryDirectory() as folder:tick(folder,API(),'actor',run)
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
