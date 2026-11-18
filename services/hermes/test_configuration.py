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

    def test_fresh_setup_saves_the_honcho_volumes_compose_uses(self):
        from tools.operations.installation import configuration
        volumes=('NOCHEH_HONCHO_DATABASE_VOLUME','NOCHEH_HONCHO_REDIS_VOLUME')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();state=root/'data/local'
            with patch.object(configuration,'INSTALLATION_ROOT',root),patch.object(configuration,'DEFAULT_STATE',state):
                initialize(state)
                saved=read_env(root/'.env')
                self.assertEqual([saved[key] for key in volumes],['nocheh_honcho_database','nocheh_honcho_redis'])
                # Honcho's folder stays unsaved, so it follows a moved checkout.
                self.assertNotIn('NOCHEH_HONCHO_STATE_DIR',saved)
                self.assertEqual(compose_environment(state)['NOCHEH_HONCHO_STATE_DIR'],str(state/'honcho'))
                # Saved names are kept: they point at the installation's existing memory.
                saved['NOCHEH_HONCHO_DATABASE_VOLUME']='synthetic-kept-memory';write_env(root/'.env',saved)
                self.assertEqual(initialize(state)['NOCHEH_HONCHO_DATABASE_VOLUME'],'synthetic-kept-memory')
        with tempfile.TemporaryDirectory() as folder:
            # A state without its own project must never name the installation's volumes.
            state=Path(folder);values=initialize(state)
            self.assertFalse(set(volumes)&set(read_env(env_path(state))))
            values['COMPOSE_PROJECT_NAME']='nocheh-synthetic-owned';write_env(env_path(state),values)
            self.assertEqual([initialize(state)[key] for key in volumes],
                             ['nocheh-synthetic-owned_honcho_database','nocheh-synthetic-owned_honcho_redis'])
        with tempfile.TemporaryDirectory() as folder:
            # With Honcho off nothing is saved, so exports still skip Honcho memory.
            state=Path(folder);write_env(state/'.env',{'COMPOSE_PROJECT_NAME':'nocheh-synthetic-owned','NOCHEH_HONCHO_ENABLED':'false'})
            initialize(state)
            self.assertFalse(set(volumes)&set(read_env(env_path(state))))

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
    def test_setup_and_make_dev_make_every_mounted_folder_private_one_level_at_a_time(self):
        import stat
        import tools.cli.main as cli
        from tools.operations.installation.configuration import DEFAULTS, generate
        # Hermes mounts only spool/brain-turns and admin/dashboard/home; Docker would make a missing one as root, and
        # admin/dashboard holds the dashboard's token, so no parent may get the default mode either.
        folders=('files','spool','spool/brain-turns','hermes','telegram','reports','admin','admin/dashboard','admin/dashboard/home')
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)/'state';initialize(state)
            for name in folders:
                with self.subTest(name=name):
                    self.assertEqual(stat.S_IMODE((state/name).stat().st_mode),0o700)
            (state/'admin/dashboard/home/config.yaml').write_text('dashboard: {font: system-mono}\n')
            initialize(state)
            self.assertTrue((state/'admin/dashboard/home/config.yaml').is_file(),'a folder that exists is left as it is')
            # make dev runs on the operating .env without initialize().
            root=Path(folder)/'main';root.mkdir()
            write_env(root/'.env',generate({**DEFAULTS,'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'123456789','TELEGRAM_BOT_TOKEN':'made-up-bot-token',
                                            'NOCHEH_HONCHO_DATABASE_VOLUME':'made-up_honcho_database','NOCHEH_HONCHO_REDIS_VOLUME':'made-up_honcho_redis'}))
            with patch('tools.development.live_dev.operating_root',return_value=root):cli.development_box_token()
            for name in folders:
                with self.subTest(dev=name):
                    self.assertEqual(stat.S_IMODE((root/'data/local'/name).stat().st_mode),0o700)

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

    def test_no_setting_lists_the_groups_nocheh_serves_or_who_may_talk_there(self):
        # Nocheh serves a group once the owner adds it there (ADR-0253), and who may talk there is a member, managed on the
        # dashboard's Members page (step 3): a list left in .env is no setting, limits nobody, and reaches no service.
        from tools.operations.installation.configuration import ROOT, validate
        from tools.operations.installation.settings import save, view
        retired=('TELEGRAM_GROUP_IDS','TELEGRAM_GROUP_ACCESS')
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize(state)
            values=read_env(env_path(state));values.update(TELEGRAM_GROUP_IDS='-10',TELEGRAM_GROUP_ACCESS='not even a list');write_env(env_path(state),values)
            # Whatever an old line holds, the rest of the settings still check and save.
            validate(load(state))
            save(state,{'TELEGRAM_BOT_NAMES':'Helper'},view(state)['revision'])
            self.assertEqual((load(state)['TELEGRAM_BOT_NAMES'],load(state)['TELEGRAM_GROUP_ACCESS']),('Helper','not even a list'))
            for key in retired:
                self.assertNotIn(key,[field['key'] for field in view(state)['fields']])
                with self.assertRaisesRegex(ValueError,'unsupported_setting'):save(state,{key:'{}'},view(state)['revision'])
        for name in ('docker-compose.yml','docker-compose.dev.yml','.env.example'):
            for key in retired:self.assertNotIn(key,(ROOT/name).read_text(),name)
        # No service reads the old member lists: the app's member directory is the only check.
        readers=[path for folder in ('services/telegram','services/hermes') for path in sorted((ROOT/folder).glob('*.py')) if not path.name.startswith('test_')]
        self.assertTrue(readers)
        for path in readers:self.assertNotIn('TELEGRAM_GROUP_ACCESS',path.read_text(),path.name)

    def test_isolated_state_does_not_use_root_credentials_or_shell_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with self.assertRaises(ValueError): load(state)
            values=initialize(state)
            self.assertEqual(env_path(state),state.resolve()/'.env')
            with patch.dict(os.environ,{'SERVICE_TOKEN':'stale-shell-value'}):
                self.assertEqual(compose_environment(state)['SERVICE_TOKEN'],values['SERVICE_TOKEN'])

    def test_environment_policy_and_explicit_empty_secret(self):
        with patch.dict(os.environ,{'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':'-10, -20','TELEGRAM_BOT_TOKEN':'','TELEGRAM_BOT_TOKEN_FILE':'/does/not/exist',
                                    'TELEGRAM_GROUP_ACCESS':'{"-10":{"granted":["77"],"denied":[]}}'},clear=True):
            # The owner and the served groups come from the app's served list (ADR-0252), and who may talk in a group from
            # its member directory (step 3), never from the environment.
            self.assertEqual(telegram_policy(),{'enabled':True})
            self.assertEqual(secret('TELEGRAM_BOT_TOKEN',required=False),'')
            with self.assertRaises(ValueError): secret('TELEGRAM_BOT_TOKEN')

    def test_a_saved_owner_id_changes_only_from_the_command_line(self):
        import re
        import sys
        import tools.cli.main as cli
        from tools.operations.installation.settings import OWNER_FROM_CLI, save, view
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize(state)
            field=lambda:next(row for row in view(state)['fields'] if row['key']=='TELEGRAM_OWNER_ID')
            self.assertEqual((field()['editable'],field().get('changes_from')),(True,None),'the first set is on the dashboard')
            save(state,{'TELEGRAM_OWNER_ID':'42','TELEGRAM_BOT_TOKEN':'made-up-bot-token'},view(state)['revision'])
            self.assertEqual((field()['editable'],field()['changes_from']),(False,'cli'),'once saved, the dashboard shows it read-only')
            # The dashboard's save never changes or clears a saved ID; other settings still save.
            before=env_path(state).read_bytes()
            for value in ('77',''):
                with self.assertRaisesRegex(ValueError,'^'+re.escape(OWNER_FROM_CLI)+'$'):save(state,{'TELEGRAM_OWNER_ID':value},view(state)['revision'])
            self.assertEqual(env_path(state).read_bytes(),before)
            save(state,{'TELEGRAM_OWNER_ID':'42','TELEGRAM_BOT_NAMES':'Helper'},view(state)['revision'])
            self.assertEqual((load(state)['TELEGRAM_OWNER_ID'],load(state)['TELEGRAM_BOT_NAMES']),('42','Helper'))

            def command(*arguments):
                output=io.StringIO()
                with patch.object(sys,'argv',['nocheh',*arguments]),patch.object(cli,'STATE',state),patch.object(cli,'bootstrap'),\
                        contextlib.redirect_stdout(output),contextlib.redirect_stderr(io.StringIO()) as errors:
                    try:code=cli.main()
                    except SystemExit as exit:code=exit.code
                return code,errors.getvalue()
            # config set changes it. An ID that is also a member's is the owner's from then on: the member directory never
            # counts the owner's account as a member, and the Members page says so (step 3).
            self.assertEqual(command('config','set','TELEGRAM_OWNER_ID','55')[0],0)
            self.assertEqual(load(state)['TELEGRAM_OWNER_ID'],'55')
            # configure-telegram lists no group any more (ADR-0253): the owner adds Nocheh to a group from their own account.
            before=env_path(state).read_bytes()
            code,errors=command('configure-telegram','--owner-id','56','--group-id','-10')
            self.assertEqual(code,2);self.assertIn(' '.join(cli.GROUP_ID_RETIRED.split()),' '.join(errors.split()))
            self.assertEqual(env_path(state).read_bytes(),before)
            self.assertEqual(command('configure-telegram','--owner-id','56')[0],0)
            self.assertEqual((load(state)['TELEGRAM_OWNER_ID'],load(state)['TELEGRAM_ENABLED']),('56','true'))
            # Members are managed on the dashboard's Members page only: the command line has no group-access command.
            code,errors=command('group-access','list')
            self.assertEqual(code,2);self.assertIn("invalid choice: 'group-access'",errors)
            self.assertFalse((cli.ROOT/'tools/operations/security/group_access.py').exists())

    def test_apply_inside_make_dev_keeps_the_development_setup(self):
        from tools.operations.installation.configuration import compose_command, INSTALLATION_ROOT
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)/'state';initialize(state)
            source=Path(folder)/'worktree';source.mkdir()
            installed=compose_command(state)
            self.assertNotIn('docker-compose.dev.yml',' '.join(installed))
            # Outside the dashboard container the setting is ignored.
            with patch.dict(os.environ,{'NOCHEH_DEV_COMPOSE_DIR':str(source)}):
                self.assertEqual(compose_command(state),installed)
            with patch.dict(os.environ,{'NOCHEH_DEV_COMPOSE_DIR':str(source),'NOCHEH_CONTAINER':'1'}):
                with self.assertRaises(ValueError):compose_command(state)
                (source/'docker-compose.dev.yml').write_text('services: {}\n')
                command=compose_command(state)
            self.assertEqual(command[command.index('--project-directory')+1],str(INSTALLATION_ROOT))
            self.assertEqual([command[i+1] for i,v in enumerate(command) if v=='-f'],
                             [str(source/'docker-compose.yml'),str(source/'docker-compose.dev.yml')])

    def test_apply_from_the_host_keeps_a_running_make_dev_stack(self):
        from subprocess import CompletedProcess
        from tools.operations.installation import configuration
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'installation';state=root/'data/local'
            source=Path(folder)/'worktree';source.mkdir()
            for name in ('docker-compose.yml','docker-compose.dev.yml'):(source/name).write_text('services: {}\n')
            with patch.object(configuration,'INSTALLATION_ROOT',root),patch.object(configuration,'DEFAULT_STATE',state),\
                 patch.dict(os.environ,{'NOCHEH_CONTAINER':''}):
                initialize(state)
                def running(ids,mounts='',code=0):
                    def run(arguments,**_):
                        output=ids if arguments[1]=='ps' else mounts
                        return CompletedProcess(arguments,code if arguments[1]=='ps' else 0,output,'')
                    return patch.object(configuration.subprocess,'run',side_effect=run)
                with running(''):
                    installed=configuration.compose_command(state)
                    self.assertNotIn('NOCHEH_DEV_SOURCE_ROOT',compose_environment(state))
                self.assertEqual(installed[installed.index('-f')+1],str(root/'docker-compose.yml'))
                with running('',code=1):self.assertEqual(configuration.compose_command(state),installed)
                with patch.object(configuration.subprocess,'run',side_effect=FileNotFoundError):
                    self.assertEqual(configuration.compose_command(state),installed)
                # After the dashboard's own apply the services carry its /dev-source Compose
                # files label; their source mount still names the checkout on this host.
                with running('app\n',f'{source}/src\n') as probe:
                    command=configuration.compose_command(state)
                    environment=compose_environment(state)
                    # Image builds and other projects keep the installed Compose file.
                    self.assertEqual(configuration.compose_command(state,development=False),installed)
                    self.assertEqual(configuration.compose_command(state,'nocheh-fixture'),installed+['-p','nocheh-fixture'])
                self.assertIn('label=com.docker.compose.project.working_dir='+str(root),probe.call_args_list[0].args[0])
                self.assertEqual(probe.call_args_list[1].args[0][-1],'app')
                self.assertEqual(command[command.index('--project-directory')+1],str(root))
                self.assertEqual([command[i+1] for i,v in enumerate(command) if v=='-f'],
                                 [str(source/'docker-compose.yml'),str(source/'docker-compose.dev.yml')])
                self.assertEqual(environment['NOCHEH_DEV_SOURCE_ROOT'],str(source))
                self.assertEqual(environment['NOCHEH_DEV_HERMES_BASE'],'nocheh-dev:hermes-base')
                # A stack whose checkout is not found on this host is refused, not replaced.
                for odd in ('', '/dev-source/src', f'{source}/dist', f'{source}/src\n{root}/src'):
                    with running('app\n',odd+'\n'),self.assertRaisesRegex(ValueError,'development_source_unavailable'):
                        configuration.compose_command(state)
                (source/'docker-compose.dev.yml').unlink()
                with running('app\n',f'{source}/src\n'),self.assertRaisesRegex(ValueError,'development_source_unavailable'):
                    configuration.compose_command(state)

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

    def test_the_database_viewer_asks_for_its_own_login_on_the_default_network(self):
        import yaml
        from tools.operations.installation.configuration import ROOT
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        viewer=compose['pgweb-archive']
        # The login comes from the environment, never the command line, and pgweb asks for it on every page.
        self.assertEqual({key:viewer['environment'][key] for key in ('PGWEB_AUTH_USER','PGWEB_AUTH_PASS')},
                         {'PGWEB_AUTH_USER':'owner','PGWEB_AUTH_PASS':'${NOCHEH_VIEWER_WEB_PASSWORD:-}'})
        self.assertFalse([part for part in viewer['command']+viewer['entrypoint'] if 'auth' in part.lower() and 'PGWEB_AUTH_PASS' not in part])
        self.assertEqual(viewer['entrypoint'][:2],['/bin/sh','-c']);self.assertIn('[ -z "$$PGWEB_AUTH_PASS" ]',viewer['entrypoint'][2])
        self.assertIn('exec /usr/bin/pgweb "$$@"',viewer['entrypoint'][2])
        self.assertIn('--readonly',viewer['command']);self.assertIn('--lock-session',viewer['command'])
        # Healthy only while it answers 401 without the login.
        self.assertEqual(viewer['healthcheck']['test'][0],'CMD-SHELL');self.assertRegex(viewer['healthcheck']['test'][1],r'%\{http_code\}.*" = 401$')
        # It keeps its restart policy and stays on the default network, with its port on loopback only.
        self.assertEqual(viewer['restart'],'unless-stopped');self.assertNotIn('networks',viewer)
        self.assertEqual(viewer['ports'],['127.0.0.1:${NOCHEH_VIEWER_PORT:-8782}:8081'])
        # The mini app and the dashboard read the same test-servers setting.
        self.assertEqual(compose['nocheh-miniapp']['environment']['TELEGRAM_TEST_ENVIRONMENT'],'${TELEGRAM_TEST_ENVIRONMENT:-}')

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

    def test_owner_sets_delivery_log_retention_for_hermes_and_the_telegram_bot(self):
        import yaml
        from tools.operations.installation.configuration import ROOT,validate
        from tools.operations.installation.settings import EDITABLE
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        # One owner setting prunes Hermes's managed-run receipts, the bot's delivery journals and the app's send records.
        for service in ('hermes','nocheh-telegram','nocheh-app'):
            self.assertEqual(compose[service]['environment']['NOCHEH_HERMES_JOURNAL_RETENTION_DAYS'],'${NOCHEH_HERMES_JOURNAL_RETENTION_DAYS:-0}',service)
        self.assertIn('NOCHEH_HERMES_JOURNAL_RETENTION_DAYS',EDITABLE)
        with tempfile.TemporaryDirectory() as folder:
            values=initialize(Path(folder))
            self.assertEqual(values['NOCHEH_HERMES_JOURNAL_RETENTION_DAYS'],'0')
            self.assertEqual(values['NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS'],'0')
            for days in ('0','1','3650'):validate({**values,'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS':days})
            for days in ('3651','-1','','x'):
                with self.assertRaises(ValueError,msg=days):validate({**values,'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS':days})

    def test_owner_sets_guard_checks_at_once_for_hermes_and_preparation(self):
        import yaml
        from tools.operations.installation.configuration import ROOT,validate
        from tools.operations.installation.settings import EDITABLE
        from services.hermes.environment import parallel
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        for service in ('hermes','nocheh-app'):
            self.assertEqual(compose[service]['environment']['NOCHEH_PARALLEL_GUARD_CHECKS'],'${NOCHEH_PARALLEL_GUARD_CHECKS:-3}',service)
        self.assertIn('NOCHEH_PARALLEL_GUARD_CHECKS',EDITABLE)
        with tempfile.TemporaryDirectory() as folder:
            values=initialize(Path(folder))
            self.assertEqual(values['NOCHEH_PARALLEL_GUARD_CHECKS'],'3')
            for checks in ('1','4'):validate({**values,'NOCHEH_PARALLEL_GUARD_CHECKS':checks})
            for checks in ('0','5','','x','03'):
                with self.assertRaises(ValueError,msg=checks):validate({**values,'NOCHEH_PARALLEL_GUARD_CHECKS':checks})
        with patch.dict(os.environ,{'NOCHEH_PARALLEL_GUARD_CHECKS':'4'}):self.assertEqual(parallel('NOCHEH_PARALLEL_GUARD_CHECKS',3,4),4)
        with patch.dict(os.environ,{'NOCHEH_PARALLEL_GUARD_CHECKS':'5'}),self.assertRaises(ValueError):parallel('NOCHEH_PARALLEL_GUARD_CHECKS',3,4)

    def test_settings_validate_and_reach_the_app_and_the_telegram_bot(self):
        import yaml
        from tools.operations.installation.configuration import DEFAULTS, ROOT, validate
        from tools.operations.installation.settings import EDITABLE
        # The product name addresses the bot by default.
        names = 'Nocheh,نوچه'
        services = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())['services']
        # The app decides addressing; the bot shows typing and reactions; Hermes gets neither.
        app, bot, hermes = (services[name]['environment'] for name in ('nocheh-app', 'nocheh-telegram', 'hermes'))
        # Without a colon, Compose keeps an owner's empty list instead of restoring the defaults.
        self.assertEqual((app['TELEGRAM_GROUP_REPLIES'], app['TELEGRAM_BOT_NAMES']),
                         ('${TELEGRAM_GROUP_REPLIES:-addressed}', '${TELEGRAM_BOT_NAMES-'+names+'}'))
        self.assertEqual((DEFAULTS['TELEGRAM_GROUP_REPLIES'], DEFAULTS['TELEGRAM_BOT_NAMES']), ('addressed', names))
        self.assertLessEqual({'TELEGRAM_GROUP_REPLIES', 'TELEGRAM_BOT_NAMES', 'TELEGRAM_TOPIC_MEMORY', 'TELEGRAM_TYPING', 'TELEGRAM_REACTIONS'}, EDITABLE)
        self.assertEqual((bot['TELEGRAM_TYPING'], DEFAULTS['TELEGRAM_TYPING']), ('${TELEGRAM_TYPING:-true}', 'true'))
        self.assertEqual((bot['TELEGRAM_REACTIONS'], DEFAULTS['TELEGRAM_REACTIONS']), ('${TELEGRAM_REACTIONS:-true}', 'true'))
        moved = {'TELEGRAM_BOT_TOKEN', 'NOCHEH_CAPTURE_ENABLED', 'TELEGRAM_GROUP_REPLIES', 'TELEGRAM_BOT_NAMES', 'TELEGRAM_TYPING', 'TELEGRAM_REACTIONS'}
        self.assertEqual(moved & set(hermes), set())
        self.assertEqual({'TELEGRAM_TYPING', 'TELEGRAM_REACTIONS', 'TELEGRAM_BOT_TOKEN'} & set(app), set())
        # Storage services decide recall scope, so the topic-memory choice reaches every service sharing the base environment.
        storage = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())['x-service']['environment']
        self.assertEqual((storage['TELEGRAM_TOPIC_MEMORY'], DEFAULTS['TELEGRAM_TOPIC_MEMORY']), ('${TELEGRAM_TOPIC_MEMORY:-group}', 'group'))
        base = {**DEFAULTS, 'NOCHEH_ARCHIVE_PASSWORD': 'a' * 64, 'NOCHEH_DERIVED_PASSWORD': 'b' * 64, 'NOCHEH_CONTROL_PASSWORD': 'c' * 64,
                'INNGEST_EVENT_KEY': 'd' * 64, 'INNGEST_SIGNING_KEY': 'e' * 64, 'INNGEST_POSTGRES_PASSWORD': 'f' * 64,
                'POSTGRES_PASSWORD': 'p' * 24, 'SERVICE_TOKEN': 's' * 24}
        validate(base)
        validate({**base, 'TELEGRAM_GROUP_REPLIES': 'all', 'TELEGRAM_BOT_NAMES': ''})
        validate({**base, 'TELEGRAM_TOPIC_MEMORY': 'topic', 'TELEGRAM_TYPING': 'false', 'TELEGRAM_REACTIONS': 'false'})
        for key, bad in (('TELEGRAM_GROUP_REPLIES', 'some'), ('TELEGRAM_BOT_NAMES', 'n' * 33), ('TELEGRAM_TOPIC_MEMORY', 'chat'), ('TELEGRAM_TYPING', 'yes'), ('TELEGRAM_REACTIONS', 'on')):
            with self.assertRaises(ValueError, msg=key):
                validate({**base, key: bad})

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
