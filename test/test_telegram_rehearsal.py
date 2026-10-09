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
