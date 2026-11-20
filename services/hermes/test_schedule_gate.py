"""Hermes's schedule tool in the owner's private chat (ADR-0266): the gate, the result notes and the mounted store."""
import json
import tempfile
import unittest
from pathlib import Path
from services.hermes import schedule_gate as gate
from services.hermes import security_launcher as launcher

PROFILE='nocheh-'+'a'*24
LOGICAL='nocheh-'+'b'*24
IMAGE='sha256:'+'c'*64


class GateTests(unittest.TestCase):
    def setUp(self):gate._BOUND=None
    def tearDown(self):gate._BOUND=None

    def call(self,**args):return gate.tool_call(tool_name=gate.TOOL,args=args)

    def test_unbound_refuses_and_other_tools_pass(self):
        self.assertEqual(self.call(action='list')['action'],'block')
        self.assertIsNone(gate.tool_call(tool_name='memory',args={'action':'add'}))
        self.assertIsNone(gate.tool_result(tool_name=gate.TOOL,result='{"success":true}'),'an unbound turn keeps the result as it is')

    def test_binds_once_with_a_time_zone(self):
        with self.assertRaises(ValueError):gate.bind('')
        gate.bind('Europe/Berlin')
        with self.assertRaises(RuntimeError):gate.bind('UTC')
        self.assertTrue(gate.bound())

    def test_create_and_update_send_here_in_the_owner_zone(self):
        gate.bind('Asia/Tokyo')
        self.assertEqual(self.call(action='create',prompt='Brief',schedule='0 8 * * 1-5',name='Morning'),
                         {'action':'modify','args':{'deliver':'telegram','timezone':'Asia/Tokyo'}})
        # Hermes's own delivery targets and zones are replaced, not refused.
        self.assertEqual(self.call(action='create',prompt='Brief',schedule='every 1h',deliver='origin',timezone='UTC')['args'],
                         {'deliver':'telegram','timezone':'Asia/Tokyo'})
        self.assertEqual(self.call(action='update',job_id='abc',prompt='New text'),{'action':'modify','args':{'deliver':'telegram'}})
        self.assertEqual(self.call(action='update',job_id='abc',schedule='0 9 * * *')['args']['timezone'],'Asia/Tokyo')
        for action in ('list','pause','resume','remove'):self.assertIsNone(self.call(action=action,job_id='abc'),action)

    def test_running_and_options_nocheh_does_not_run_are_refused(self):
        gate.bind('UTC')
        for action in ('run','trigger','cancel'):self.assertEqual(self.call(action=action,job_id='abc')['message'],gate.RUN_REFUSED)
        self.assertIn('Use one of',self.call(action='explode')['message'])
        for extra in ({'script':'x.py'},{'no_agent':True},{'skills':['a']},{'model':'other'},{'base_url':'https://example.test'},
                      {'enabled_toolsets':['terminal']},{'workdir':'/'},{'context_from':['x']},{'paused':True}):
            blocked=self.call(action='create',prompt='p',schedule='every 1h',**extra)
            self.assertEqual(blocked['action'],'block',extra);self.assertIn(next(iter(extra)),blocked['message'])
        # Empty values of other arguments are what Hermes's schema sends by default.
        self.assertEqual(self.call(action='create',prompt='p',schedule='every 1h',script='',skills=[],no_agent=False,paused=False)['action'],'modify')

    def test_a_member_limit_counts_what_this_reply_adds(self):
        gate.bind('UTC',limit=2,count=1)
        self.assertEqual(self.call(action='create',prompt='p',schedule='every 1h')['action'],'modify')
        gate.tool_result(tool_name=gate.TOOL,result=json.dumps({'success':True,'job_id':'abc'}))
        self.assertIn('2 schedules',self.call(action='create',prompt='p',schedule='every 1h')['message'])

    def test_a_result_keeps_hermes_fields_and_gets_nocheh_note(self):
        gate.bind('UTC')
        raw=json.dumps({'success':True,'job_id':'abc','name':'Morning','next_run_at':'2026-11-21T08:00:00+00:00',
                        'message':'Delivered by the gateway to your home channel','delivery_warning':'gateway not running'})
        value=json.loads(gate.tool_result(tool_name=gate.TOOL,result=raw))
        self.assertEqual(set(value),{'success','job_id','name','next_run_at','note'})
        self.assertEqual(value['note'],gate.NOTE)
        self.assertNotIn('note',json.loads(gate.tool_result(tool_name=gate.TOOL,result='{"success":false,"error":"bad schedule"}')))
        self.assertIsNone(gate.tool_result(tool_name=gate.TOOL,result='not json'))


class HermesToolTests(unittest.TestCase):
    """The gate's changed arguments are what Hermes's own tool accepts, and its store is what Nocheh's scheduler reads."""
    def setUp(self):gate._BOUND=None
    def tearDown(self):gate._BOUND=None

    def test_a_create_through_the_gate_lands_in_the_chat_store(self):
        import os
        from unittest.mock import patch
        from tools.cronjob_tools import _cronjob_handler,check_cronjob_requirements
        from services.hermes.native_cron import inspect,store
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'HERMES_GATEWAY_SESSION':'1'}):
            self.assertTrue(check_cronjob_requirements(),'a reply that may set schedules is offered the tool')
            gate.bind('Asia/Tokyo')
            args={'action':'create','prompt':'Brief me. Answer [SILENT] if nothing is new.','schedule':'0 8 * * 1-5','name':'Morning brief'}
            changed=gate.tool_call(tool_name=gate.TOOL,args=args)
            home=Path(temp)
            with store(home):
                raw=_cronjob_handler({**args,**changed['args']})
            value=json.loads(gate.tool_result(tool_name=gate.TOOL,result=raw))
            self.assertTrue(value['success'],raw);self.assertEqual(value['note'],gate.NOTE)
            job,=inspect(home)
            self.assertEqual((job['deliver'],job['timezone'],job['name']),('telegram','Asia/Tokyo','Morning brief'))
            self.assertFalse(job.get('nocheh_registered'),'nothing runs before Nocheh captures it')


class TurnTests(unittest.TestCase):
    """Which replies are offered the tool: only the owner's own, isolated, with the store mounted and Nocheh's yes."""
    def setUp(self):gate._BOUND=None
    def tearDown(self):gate._BOUND=None

    def test_only_the_owners_own_isolated_reply_with_its_store_gets_the_tool(self):
        import os
        from unittest.mock import patch
        from services.hermes import assistant_turn
        body={'owner':True,'channel':'telegram'}
        answers=[]
        def request(path,body=None,timeout=None):
            answers.append(path);return {'allowed':True,'time_zone':'Asia/Tokyo','limit':None,'count':None}
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'1'}),\
                patch('services.hermes.archive_tools.request',request):
            os.environ.pop('HERMES_GATEWAY_SESSION',None)
            profile=Path(temp)
            self.assertFalse(assistant_turn.schedule_turn(body,profile),'no store mounted')
            (profile/'cron').mkdir()
            for flags in ({'review':True},{'background':True},{'box':True},{'machine':True},{'answer':True},{'member':True},{'member_read':True}):
                self.assertFalse(assistant_turn.schedule_turn(body,profile,**flags),flags)
            for other in ({'owner':False,'channel':'telegram'},{'owner':True,'channel':'scheduler'}):
                self.assertFalse(assistant_turn.schedule_turn(other,profile),other)
            self.assertEqual(answers,[],'Nocheh is asked only for a reply that could get the tool')
            with patch('services.hermes.archive_tools.request',lambda *a,**k:{'allowed':False}):
                self.assertFalse(assistant_turn.schedule_turn(body,profile),'Nocheh said no: a forward, or not the owner\'s message')
            self.assertFalse(gate.bound())
            self.assertTrue(assistant_turn.schedule_turn(body,profile))
            self.assertEqual((answers,gate._BOUND['time_zone'],os.environ.get('HERMES_GATEWAY_SESSION')),(['/v1/schedules/turn'],'Asia/Tokyo','1'))
            os.environ.pop('HERMES_GATEWAY_SESSION',None)
        with patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'0'}):
            gate._BOUND=None;self.assertFalse(assistant_turn.schedule_turn(body,Path('/nonexistent')),'never outside a sealed turn')


class StoreMountTests(unittest.TestCase):
    def binding(self,**extra):return {'owner':True,'logical_profile':LOGICAL,**extra}

    def test_only_the_owners_own_reply_gets_its_chat_store(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/LOGICAL).mkdir()
            self.assertIsNone(launcher.schedule_store(self.binding(),False,False,root),'no store folder yet')
            (root/LOGICAL/'cron').mkdir()
            self.assertEqual(launcher.schedule_store(self.binding(),False,False,root),LOGICAL)
            for binding,boxed,machine in ((self.binding(owner=False),False,False),(self.binding(job='abc'),False,False),
                                          (self.binding(),True,False),(self.binding(),False,True),
                                          (self.binding(logical_profile='profile-x'),False,False)):
                self.assertIsNone(launcher.schedule_store(binding,boxed,machine,root),(binding,boxed,machine))
            (root/LOGICAL/'cron').rmdir();(root/LOGICAL/'cron').symlink_to(root)
            self.assertIsNone(launcher.schedule_store(self.binding(),False,False,root),'a linked store is never mounted')

    def test_the_store_is_mounted_read_write_at_the_turn_home(self):
        spec=launcher.container_spec(PROFILE,'/owned/profiles',IMAGE,'nocheh-agent',1000,1000,schedules=LOGICAL)
        self.assertIn({'Type':'bind','Source':'/owned/profiles/'+LOGICAL+'/cron','Target':'/profile/cron','ReadOnly':False},spec['HostConfig']['Mounts'])
        plain=launcher.container_spec(PROFILE,'/owned/profiles',IMAGE,'nocheh-agent',1000,1000)
        self.assertFalse([m for m in plain['HostConfig']['Mounts'] if m['Target']=='/profile/cron'])
        for bad in ({'schedules':'../x'},{'schedules':LOGICAL,'machine':True}):
            with self.assertRaises(ValueError):launcher.container_spec(PROFILE,'/owned/profiles',IMAGE,'nocheh-agent',1000,1000,**bad)


if __name__=='__main__':unittest.main()
