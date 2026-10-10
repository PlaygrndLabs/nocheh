import os
import io
import contextlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.installation.configuration import initialize, read_env, write_env, env_path, load, compose_environment
from services.hermes.environment import secret, telegram_policy


class ConfigurationTests(unittest.TestCase):
    def test_fresh_setup_enables_prepared_honcho_without_overriding_an_explicit_disable(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            self.assertEqual(values['NOCHEH_HONCHO_ENABLED'],'true')
            self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'honcho')
            token=values['NOCHEH_MEMORY_TOKEN']
            self.assertTrue(token)
            self.assertEqual((state/'honcho/internal_token').read_text().strip(),token)
            self.assertEqual(initialize(state)['NOCHEH_MEMORY_TOKEN'],token)
            self.assertTrue((state/'honcho/honcho.env').is_file())
            self.assertTrue((state/'honcho/meter.env').is_file())
            values['NOCHEH_HONCHO_ENABLED']='false';write_env(env_path(state),values)
            self.assertEqual(initialize(state)['NOCHEH_HONCHO_ENABLED'],'false')
            self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'')

    def test_auto_migrates_to_on_and_new_configuration_has_only_two_states(self):
        from tools.operations.installation.configuration import validate
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            self.assertEqual(values['NOCHEH_GUARD_MODE'],'on')
            values['NOCHEH_GUARD_MODE']='auto';write_env(env_path(state),values)
            self.assertEqual(load(state)['NOCHEH_GUARD_MODE'],'on')
            self.assertEqual(initialize(state)['NOCHEH_GUARD_MODE'],'on')
            self.assertEqual(read_env(env_path(state))['NOCHEH_GUARD_MODE'],'on')
            with self.assertRaises(ValueError):validate(values)
    def test_literal_roundtrip_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'.env'
            values={'TOKEN': "abc$NOT_EXPANDED# with ' quote", 'EMPTY':'', 'JSON':'["x"]'}
            write_env(path,values)
            self.assertEqual(read_env(path),values)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            path.write_text('A="quoted" # comment\nB=literal # comment\n')
            self.assertEqual(read_env(path),{'A':'quoted','B':'literal'})
            path.write_text('A=first\nA=second\n')
            with self.assertRaisesRegex(ValueError,'Duplicate'): read_env(path)

    def test_setup_preserves_archive_credentials_without_importing_provider_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'secrets').mkdir()
            (state/'secrets/database_password').write_text('old-db-password-'*3)
            (state/'secrets/service_token').write_text('old-service-token-'*3)
            (state/'.env').write_text('UNRELATED_PROVIDER_KEY=unused\n')
            values=initialize(state)
            self.assertEqual(values['UNRELATED_PROVIDER_KEY'],'unused')
            self.assertNotEqual(values['POSTGRES_PASSWORD'],'old-db-password-'*3)
            self.assertNotEqual(values['SERVICE_TOKEN'],'old-service-token-'*3)
            self.assertFalse((state/'previous-configuration').exists())
            self.assertEqual(initialize(state),values)
            # An active .env must never inherit settings from retired sidecars.
            (state/'assistant.json').write_text('{"enabled":true,"owner_id":"42","group_ids":[]}')
            self.assertEqual(initialize(state)['TELEGRAM_ENABLED'],'false')

    def test_isolated_state_does_not_use_root_credentials_or_shell_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with self.assertRaises(ValueError): load(state)
            values=initialize(state)
            self.assertEqual(env_path(state),state.resolve()/'.env')
            with patch.dict(os.environ,{'SERVICE_TOKEN':'stale-shell-value'}):
                self.assertEqual(compose_environment(state)['SERVICE_TOKEN'],values['SERVICE_TOKEN'])

    def test_environment_policy_and_explicit_empty_secret(self):
        with patch.dict(os.environ,{'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':'-10, -20','TELEGRAM_BOT_TOKEN':'','TELEGRAM_BOT_TOKEN_FILE':'/does/not/exist'},clear=True):
            self.assertEqual(telegram_policy(),{'enabled':True,'owner_id':'42','group_ids':['-10','-20'],'group_access':{}})
            self.assertEqual(secret('TELEGRAM_BOT_TOKEN',required=False),'')
            with self.assertRaises(ValueError): secret('TELEGRAM_BOT_TOKEN')

    def test_group_access_grant_deny_revoke_and_invalid_setting(self):
        from tools.operations.installation.configuration import group_access, validate
        from tools.operations.installation.settings import save, view
        from tools.operations.security.group_access import main
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            save(state,{'TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':'-10'},view(state)['revision'])
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(state,['grant','-10','77','--save-only']),0)
                self.assertEqual(main(state,['deny','-10','77','--save-only']),0)
            self.assertEqual(group_access(load(state)),{'-10':{'granted':[],'denied':['77']}})
            with contextlib.redirect_stdout(output):self.assertEqual(main(state,['revoke','-10','77','--save-only']),0)
            self.assertEqual(group_access(load(state)),{})
            for bad in ('{"-20":{"granted":["77"],"denied":[]}}',
                        '{"-10":{"granted":["42"],"denied":[]}}',
                        '{"-10":{"granted":"77","denied":[]}}'):
                with self.assertRaisesRegex(ValueError,'TELEGRAM_GROUP_ACCESS'):
                    validate({**load(state),'TELEGRAM_GROUP_ACCESS':bad})

    def test_native_admin_port_follows_isolated_archive_port(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); values = initialize(state)
            values['NOCHEH_PORT'] = '8795'; write_env(env_path(state), values)
            self.assertEqual(compose_environment(state)['NOCHEH_NATIVE_ADMIN_PORT'], '8800')

    def test_every_compose_service_rotates_its_log_with_owner_adjustable_limits(self):
        import yaml
        from tools.operations.installation.configuration import ROOT,validate
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())
        for name,service in compose['services'].items():
            self.assertEqual(service.get('logging'),{'driver':'json-file','options':{
                'max-size':'${NOCHEH_LOG_MAX_SIZE:-10m}','max-file':'${NOCHEH_LOG_MAX_FILES:-3}'}},name)
        with tempfile.TemporaryDirectory() as folder:
            values=initialize(Path(folder))
            self.assertEqual((values['NOCHEH_LOG_MAX_SIZE'],values['NOCHEH_LOG_MAX_FILES']),('10m','3'))
            validate({**values,'NOCHEH_LOG_MAX_SIZE':'500k','NOCHEH_LOG_MAX_FILES':'10'})
            for key,bad in [('NOCHEH_LOG_MAX_SIZE','0m'),('NOCHEH_LOG_MAX_SIZE','10'),('NOCHEH_LOG_MAX_SIZE','10mb'),
                            ('NOCHEH_LOG_MAX_FILES','0'),('NOCHEH_LOG_MAX_FILES','1000'),('NOCHEH_LOG_MAX_FILES','')]:
                with self.assertRaises(ValueError,msg=key+'='+bad):validate({**values,key:bad})

    def test_owner_sets_parallel_runs_and_replies_and_replies_never_exceed_runs(self):
        import yaml
        from tools.operations.installation.configuration import ROOT,validate
        from tools.operations.installation.settings import EDITABLE
        from services.hermes.environment import parallel
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        self.assertEqual(compose['hermes']['environment']['NOCHEH_PARALLEL_REPLIES'],'${NOCHEH_PARALLEL_REPLIES:-3}')
        self.assertEqual(compose['hermes-agent-sb']['environment']['NOCHEH_PARALLEL_RUNS'],'${NOCHEH_PARALLEL_RUNS:-4}')
        self.assertLessEqual({'NOCHEH_PARALLEL_RUNS','NOCHEH_PARALLEL_REPLIES'},EDITABLE)
        with tempfile.TemporaryDirectory() as folder:
            values=initialize(Path(folder))
            self.assertEqual((values['NOCHEH_PARALLEL_RUNS'],values['NOCHEH_PARALLEL_REPLIES']),('4','3'))
            for runs,replies in [('1','1'),('8','8'),('6','4')]:
                validate({**values,'NOCHEH_PARALLEL_RUNS':runs,'NOCHEH_PARALLEL_REPLIES':replies})
            for runs,replies in [('4','5'),('0','1'),('9','3'),('4','0'),('4',''),('',''),('4','2.5'),('04','3')]:
                with self.assertRaises(ValueError,msg=runs+'/'+replies):
                    validate({**values,'NOCHEH_PARALLEL_RUNS':runs,'NOCHEH_PARALLEL_REPLIES':replies})
        with patch.dict(os.environ,{},clear=True):self.assertEqual(parallel('NOCHEH_PARALLEL_REPLIES',3),3)
        with patch.dict(os.environ,{'NOCHEH_PARALLEL_REPLIES':'5'}):self.assertEqual(parallel('NOCHEH_PARALLEL_REPLIES',3),5)
        for bad in ('0','9','two','-1'):
            with patch.dict(os.environ,{'NOCHEH_PARALLEL_RUNS':bad}),self.assertRaises(ValueError,msg=bad):parallel('NOCHEH_PARALLEL_RUNS',4)

    def test_separate_storage_credentials_are_private_stable_and_explicitly_selected(self):
        from tools.operations.installation.configuration import compose_command,validate
        from tools.operations.installation.settings import view,save
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            names=['NOCHEH_'+name+'_PASSWORD' for name in ('ARCHIVE','DERIVED','CONTROL')]
            self.assertEqual(values['NOCHEH_STORAGE_LAYOUT'],'original-only-v1')
            self.assertEqual(len(set(values[name] for name in names)),3)
            self.assertEqual(initialize(state),values)
            fields=view(state)
            for name in names:
                self.assertNotIn(values[name],str(fields))
                with self.assertRaisesRegex(ValueError,'unsupported_setting'):save(state,{name:'replacement'},fields['revision'])
            with self.assertRaisesRegex(ValueError,'unsupported_setting'):save(state,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'},fields['revision'])
            with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
                self.assertEqual(compose_command(state).count('-f'),1)
                self.assertEqual(compose_environment(state)['NOCHEH_STORAGE_LAYOUT'],'original-only-v1')
            values['NOCHEH_STORAGE_LAYOUT']='original-only-v1';validate(values);write_env(env_path(state),values)
            self.assertTrue(compose_command(state)[-1].endswith('/docker-compose.yml'))
            with self.assertRaises(ValueError):validate({**values,'NOCHEH_STORAGE_LAYOUT':'legacy'})
            for bad in ['',values[names[0]],values['POSTGRES_PASSWORD']]:
                with self.assertRaises(ValueError):validate({**values,names[1]:bad})
