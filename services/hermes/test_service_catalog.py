import unittest
from tools.operations.installation.services import describe


class ServiceCatalogTests(unittest.TestCase):
    def test_retired_init_and_optional_tools_are_not_failures(self):
        rows=[{'service':'inngest-db-init','state':'exited','exit_code':0},
              {'service':'honcho-deriver','state':'running','health':'unhealthy'},
              {'service':'nocheh-app','state':'running','health':'healthy'}]
        services={row['service']:row for row in describe(rows,{'NOCHEH_HONCHO_ENABLED':'true'})}
        self.assertEqual(services['inngest-db-init']['state'],'optional-stopped')
        self.assertNotIn('inngest-db-init',{row['service'] for row in describe([], {})})
        self.assertEqual(services['pgweb-archive']['state'],'optional-stopped')
        self.assertEqual(services['honcho-deriver']['state'],'unhealthy')
        self.assertEqual(services['nocheh-app']['state'],'running')
        self.assertEqual(services['nocheh-dashboard']['location'],'docker')
        self.assertEqual(services['inngest-server']['state'],'unhealthy')
        for row in services.values():self.assertTrue(row['tool'] and row['purpose'])

    def test_the_machine_service_is_expected_running_and_every_compose_service_is_listed(self):
        import yaml
        from tools.operations.installation.configuration import ROOT
        from tools.operations.installation.services import CATALOG
        # It starts with the rest even while machine control is unused: without it no machine can be added or tested.
        services={row['service']:row for row in describe([{'service':'nocheh-machines','state':'running','health':'healthy'}],{})}
        self.assertEqual((services['nocheh-machines']['expected_state'],services['nocheh-machines']['state']),('running','running'))
        self.assertEqual({row['service']:row for row in describe([],{})}['nocheh-machines']['state'],'unhealthy')
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        listed={name for name,*_ in CATALOG}
        self.assertEqual({name for name,service in compose.items() if 'reset' not in (service.get('profiles') or [])}-listed,set())

    def test_the_telegram_bot_is_the_only_service_given_the_token_and_waits_only_for_the_app(self):
        import yaml
        from tools.operations.installation.configuration import ROOT
        compose=yaml.safe_load((ROOT/'docker-compose.yml').read_text())['services']
        holders={name for name,service in compose.items() if 'TELEGRAM_BOT_TOKEN' in (service.get('environment') or {})}
        self.assertEqual(holders,{'nocheh-telegram'})
        bot=compose['nocheh-telegram']
        # A brain restart must not stop polling, and the incident file outlives the bot's restart.
        self.assertEqual(bot['depends_on'],{'nocheh-app':{'condition':'service_healthy'}})
        self.assertEqual((bot['image'],bot['command'],bot['read_only'],bot['networks']),
                         ('${NOCHEH_IMAGES:-nocheh}-hermes:local',['python','-m','services.telegram.server'],True,['default']))
        self.assertNotIn('build',bot);self.assertNotIn('ports',bot)
        self.assertEqual(bot['volumes'],['${NOCHEH_STATE_DIR:-./data/local}/spool:/data/spool',
                                         '${NOCHEH_STATE_DIR:-./data/local}/telegram:/telegram-state'])
        self.assertEqual((bot['environment']['NOCHEH_TELEGRAM_STATE'],bot['environment']['PORT']),('/telegram-state','8784'))
        self.assertEqual(compose['nocheh-app']['environment']['TELEGRAM_URL'],'http://nocheh-telegram:8784')
        services={row['service']:row for row in describe([{'service':'nocheh-telegram','state':'running','health':'healthy'}],{})}
        self.assertEqual((services['nocheh-telegram']['expected_state'],services['nocheh-telegram']['state']),('running','running'))
