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
        # Hermes's own delivery targets are replaced, not refused; a zone the owner named is kept.
        self.assertEqual(self.call(action='create',prompt='Brief',schedule='every 1h',deliver='origin',timezone='Europe/Berlin')['args'],
                         {'deliver':'telegram'})
        self.assertEqual(self.call(action='update',job_id='abc',prompt='New text'),{'action':'modify','args':{'deliver':'telegram'}})
        self.assertNotIn('timezone',self.call(action='update',job_id='abc',schedule='0 9 * * *')['args'],'a changed time keeps its zone')
        self.assertEqual(self.call(action='update',job_id='abc',timezone='America/New_York')['args'],{'deliver':'telegram'})
        self.assertEqual(self.call(action='update',job_id='abc',timezone='')['args']['timezone'],'Asia/Tokyo','a cleared zone is the owner\'s')
        for zone in ('Not/AZone','../etc','x'*70,7):
            blocked=self.call(action='create',prompt='Brief',schedule='every 1h',timezone=zone)
            self.assertEqual(blocked['action'],'block',zone);self.assertIn('not a time zone',blocked['message'])
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
            # A zone the owner named reaches the store as named.
            named={'action':'create','prompt':'Weekly review','schedule':'0 18 * * 5','name':'Review','timezone':'Europe/Berlin'}
            with store(home):
                raw=_cronjob_handler({**named,**gate.tool_call(tool_name=gate.TOOL,args=named)['args']})
            self.assertTrue(json.loads(raw)['success'],raw)
            self.assertEqual({row['name']:row['timezone'] for row in inspect(home)},{'Morning brief':'Asia/Tokyo','Review':'Europe/Berlin'})


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
            os.environ.pop('HERMES_GATEWAY_SESSION',None);os.environ.pop('NOCHEH_SCHEDULE_STORE',None)
            profile=Path(temp)
            self.assertFalse(assistant_turn.schedule_turn(body,profile),'no store mounted')
            # A cron folder Hermes made on the turn's scratch /profile is not the chat's store: it is lost with the turn.
            (profile/'cron').mkdir()
            self.assertFalse(assistant_turn.schedule_turn(body,profile),'the launcher did not mount the store')
            self.assertEqual(answers,[])
            os.environ['NOCHEH_SCHEDULE_STORE']='1'
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
            # A member's own reply in their private chat (members' schedules): not the owner's, with the member's limit.
            gate._BOUND=None;answers.clear()
            member={'owner':False,'channel':'telegram'}
            self.assertFalse(assistant_turn.schedule_turn(member,profile),'not a member turn')
            with patch('services.hermes.archive_tools.request',lambda *a,**k:{'allowed':True,'time_zone':'Asia/Tokyo','limit':5,'count':2}):
                for flags in ({'member':True,'member_read':True},{'member':True,'background':True},{'member':True,'answer':True}):
                    self.assertFalse(assistant_turn.schedule_turn(member,profile,**flags),flags)
                self.assertTrue(assistant_turn.schedule_turn(member,profile,member=True))
            self.assertEqual((gate._BOUND['limit'],gate._BOUND['count']),(5,2))
            os.environ.pop('HERMES_GATEWAY_SESSION',None);os.environ.pop('NOCHEH_SCHEDULE_STORE',None)
        with patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'0','NOCHEH_SCHEDULE_STORE':'1'}):
            gate._BOUND=None;self.assertFalse(assistant_turn.schedule_turn(body,Path('/nonexistent')),'never outside a sealed turn')


class StoreMountTests(unittest.TestCase):
    def binding(self,**extra):return {'owner':True,'logical_profile':LOGICAL,**extra}

    def test_the_owner_turn_makes_the_chat_store_the_launcher_then_mounts(self):
        from services.hermes.scopes import Scopes
        from services.hermes.turn_process import schedule_store
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);logical=Scopes.profile('42')
            # The chat's own folder may not exist yet: only revisioned profiles do.
            self.assertEqual(schedule_store(root,'42'),root/logical/'cron')
            self.assertTrue((root/logical/'cron').is_dir())
            self.assertEqual(launcher.schedule_store({'owner':True,'logical_profile':logical},False,False,root),logical)
            self.assertEqual(schedule_store(root,'42'),root/logical/'cron','a second turn finds it')
            other=root/Scopes.profile('43');other.symlink_to(root/logical)
            self.assertIsNone(schedule_store(root,'43'),'a linked folder is left alone')

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
        self.assertIn('NOCHEH_SCHEDULE_STORE=1',spec['Env'],'the turn is told its store is mounted')
        plain=launcher.container_spec(PROFILE,'/owned/profiles',IMAGE,'nocheh-agent',1000,1000)
        self.assertFalse([m for m in plain['HostConfig']['Mounts'] if m['Target']=='/profile/cron'])
        self.assertNotIn('NOCHEH_SCHEDULE_STORE=1',plain['Env'])
        for bad in ({'schedules':'../x'},{'schedules':LOGICAL,'machine':True}):
            with self.assertRaises(ValueError):launcher.container_spec(PROFILE,'/owned/profiles',IMAGE,'nocheh-agent',1000,1000,**bad)


if __name__=='__main__':unittest.main()
