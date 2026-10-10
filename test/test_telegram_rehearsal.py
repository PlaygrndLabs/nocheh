"""The synthetic polling extension must not borrow an operating installation."""
import copy
import unittest
from tools.paths import ROOT
from tools.acceptance.telegram_rehearsal import validate_fixture


class TelegramRehearsalOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.directory=ROOT/'data/acceptance/results/synthetic-test'
        self.project='nocheh-installation-'+'a'*12
        self.info={'project':self.project,'directory':str(self.directory),'images':{'native':'sha256:'+'b'*64}}
        self.manifest={'name':self.project,'networks':{'default':{'internal':True,'name':self.project+'_default'}},
            'services':{'hermes':{'image':self.info['images']['native'],'volumes':[{'type':'bind',
                'source':str(self.directory/'state/hermes'),'target':'/workspace/data/local/hermes'}]},
                'cliproxy-api':{'environment':{'NOCHEH_INSTALLATION_FIXTURE':'1'}}}}

    def test_only_matching_owned_fixture_is_admitted(self):
        self.assertEqual(validate_fixture(self.directory,self.info,self.manifest),self.project)
        self.info['directory']=str(ROOT/'data/local')
        with self.assertRaisesRegex(ValueError,'invalid_fixture_project'):validate_fixture(self.directory,self.info,self.manifest)

    def test_network_escape_and_operating_network_reuse_are_rejected(self):
        for change in ({'internal':False},{'external':True},{'name':'nocheh-agent'}):
            with self.subTest(change=change):
                manifest=copy.deepcopy(self.manifest);manifest['networks']['default'].update(change)
                with self.assertRaisesRegex(ValueError,'isolated_fixture_required'):validate_fixture(self.directory,self.info,manifest)
        self.manifest['services']['hermes']['ports']=['8781:8781']
        with self.assertRaisesRegex(ValueError,'isolated_fixture_required'):validate_fixture(self.directory,self.info,self.manifest)

    def test_only_the_loopback_dashboard_preview_relay_may_leave_the_internal_networks(self):
        manifest=copy.deepcopy(self.manifest)
        manifest['networks']['preview']={'name':self.project+'-preview'}
        manifest['services']['fixture-preview']={'networks':{'default':None,'preview':None},
            'ports':[{'target':18793,'published':'18793','host_ip':'127.0.0.1','protocol':'tcp'}]}
        self.assertEqual(validate_fixture(self.directory,self.info,manifest),self.project)
        for change in (lambda m:m['services']['fixture-preview']['ports'][0].update(host_ip='0.0.0.0'),
                       lambda m:m['services']['hermes'].update(networks={'preview':None}),
                       lambda m:m['networks']['preview'].update(name='nocheh_default'),
                       lambda m:m['services']['fixture-preview'].update(volumes=[{'type':'bind','source':'/'}])):
            with self.subTest(change=change):
                bad=copy.deepcopy(manifest);change(bad)
                with self.assertRaisesRegex(ValueError,'isolated_fixture_required'):validate_fixture(self.directory,self.info,bad)

    def test_operating_native_state_or_unverified_image_is_rejected(self):
        manifest=copy.deepcopy(self.manifest)
        manifest['services']['hermes']['volumes'][0]['source']=str(ROOT/'data/local/hermes')
        with self.assertRaisesRegex(ValueError,'owned_native_state_required'):validate_fixture(self.directory,self.info,manifest)
        self.manifest['services']['hermes']['image']='nocheh-hermes:local'
        with self.assertRaisesRegex(ValueError,'synthetic_fixture_required'):validate_fixture(self.directory,self.info,self.manifest)


if __name__=='__main__':unittest.main()


class TelegramMockMarkdownTests(unittest.TestCase):
    """The Bot API mock answers MarkdownV2 like Telegram, so a valid reply is
    never rejected by the fixture and a malformed one gets Telegram's error."""
    def setUp(self):
        import os
        os.environ['NOCHEH_INSTALLATION_FIXTURE']='1'
        from tools.acceptance.telegram_mock import markdown_v2
        self.parse=markdown_v2

    def test_entities_and_escapes_become_plain_text(self):
        self.assertEqual(self.parse('سلام\\. *پررنگ* و `co\\`de`'),
            ('سلام. پررنگ و co`de',[{'type':'bold','offset':6,'length':5},{'type':'code','offset':14,'length':5}]))
        self.assertEqual(self.parse('Password: *\\*\\*\\**')[0],'Password: ***')

    def test_malformed_markup_gets_telegram_wording(self):
        with self.assertRaisesRegex(ValueError,"Can't find end of Bold entity at byte offset 10"):self.parse('Password: *\\*\\*')
        with self.assertRaisesRegex(ValueError,"Character '.' is reserved"):self.parse('a.b')


class RealModelFixtureTests(unittest.TestCase):
    """Real answers keep Telegram mocked and open exactly two bounded routes."""
    def test_transform_bridges_only_the_relay_and_the_meter(self):
        import tempfile
        from pathlib import Path
        from tools.acceptance.model_rehearsal import validate_paid_egress
        from tools.acceptance.real_model_fixture import transform
        project='nocheh-installation-'+'c'*12
        internal=lambda name:{'internal':True,'name':project+'-'+name}
        manifest={'name':project,'networks':{'default':internal('default'),'memory':internal('memory')},'secrets':{'temporary_embedding_key':{'file':'/x'}},
            'services':{'cliproxy-api':{'environment':{'NOCHEH_INSTALLATION_FIXTURE':'1'},'networks':{'default':None,'memory':None},
                'volumes':[{'type':'bind','source':'/s','target':'/fixture-state'},{'type':'bind','source':'/p','target':'/fixture/provider.py'}]},
                'honcho-provider-gateway':{'environment':{'NOCHEH_INSTALLATION_FIXTURE':'1'},'networks':{'memory':None},
                'volumes':[{'type':'bind','source':'/l','target':'/ledger'},{'type':'bind','source':'/p','target':'/fixture/provider.py'}]},
                'hermes':{'networks':{'default':None}}}}
        with tempfile.TemporaryDirectory() as folder:
            operating=Path(folder)
            for real in (True,False):
                with self.subTest(real=real):
                    result=transform(copy.deepcopy(manifest),ROOT/'data/acceptance/results/x',operating/'keys',operating/'honcho','bridge',300,real)
                    validate_paid_egress(result)
                    relay=result['services']['cliproxy-api']
                    self.assertEqual(relay['environment']['NOCHEH_INSTALLATION_FIXTURE'],'1')
                    self.assertNotIn('NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED',relay['environment'])
                    self.assertIn('/fixture-state',[mount['target'] for mount in relay['volumes']])
                    self.assertTrue(all(mount.get('read_only') for mount in relay['volumes'] if mount['target']!='/fixture-state'))
                    meter=result['services']['honcho-provider-gateway']
                    self.assertEqual(meter.get('command')==['python','/fixture/services/honcho/meter.py'],real)
                    self.assertEqual('NOCHEH_INSTALLATION_FIXTURE' in meter['environment'],not real)
