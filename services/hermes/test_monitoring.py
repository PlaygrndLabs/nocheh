import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.provider import monitoring


class MonitoringTests(unittest.TestCase):
    def test_a_failed_calls_exact_error_reaches_health_and_the_notice_from_the_usage_tracker(self):
        from datetime import datetime, timezone
        from services.hermes import usage
        from tools.operations.provider import problems
        now = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as state:
            path = Path(state) / 'hermes/usage/usage.sqlite'
            path.parent.mkdir(parents=True)
            usage.record('memory_review', {'calls': 1}, 'synthetic-model', failed=True, reason='provider_error', cause='overloaded:529',
                         provider='anthropic', path=path, now=now.timestamp())
            usage.record('memory_review', {'calls': 1}, 'synthetic-model', provider='anthropic', path=path, now=now.timestamp())
            rows = monitoring.model_problems(state, now)
        self.assertEqual((rows[0]['causes'], rows[0]['why']), ({'provider_error:overloaded:529': 1}, '1 the provider was overloaded (HTTP 529)'))
        found = [problem for problem in problems.problems({}, rows, '2026-10-13') if problem['kind'] == 'model']
        self.assertEqual(problems.text(found[0], 1),
                         'Memory notes (synthetic-model): 1 model call failed today: 1 the provider was overloaded (HTTP 529).')

    def test_github_flags_come_from_the_app_file_without_its_key(self):
        from tools.operations.connections import secret_file
        pem='-----BEGIN RSA PRIVATE KEY-----\nMONITOR'+'x'*40+'\n-----END RSA PRIVATE KEY-----\n'
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with secret_file.locked(state,'github'):
                secret_file.write(state,'github',{'app':{'id':7,'slug':'nocheh-example','name':'Nocheh-example','account':'octo-example',
                                                         'account_type':'User','pem':pem,'connected_at':1},'reconnect':False,'listed':[],'listed_at':1})
            with patch.object(monitoring,'load',return_value={}),patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value=''),patch.object(monitoring.API,'call',side_effect=ConnectionError('down')):
                result=monitoring.status(state)
            self.assertEqual(result['github'],{'connected':True,'reconnect':False})
            self.assertNotIn('MONITOR',json.dumps(result))
            secret_file.path(state,'github').unlink()
            self.assertEqual(monitoring.github_flags(state),{'connected':False,'reconnect':False})

    def test_partial_outage_retains_model_routes_and_safe_telegram_incident(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'hermes').mkdir()
            (state/'hermes/gateway_state.json').write_text(json.dumps({'platforms':{'telegram':{
                'state':'fatal','error_code':'telegram_network_error','error_message':'private token must stay out',
                'updated_at':'2026-09-11T07:04:41Z'}}}))
            config={'TELEGRAM_ENABLED':'true','NOCHEH_PROVIDERS':json.dumps([{'id':'gateway','name':'Synthetic gateway','url':'https://gateway.example.test/v1'}]),
                    'NOCHEH_PROVIDER_KEYS':'{"gateway":"private-key"}','NOCHEH_REPLY_PROVIDER':'gateway','NOCHEH_MODEL':'synthetic-model',
                    'SERVICE_TOKEN':'private-service-token'}
            with patch.object(monitoring,'load',return_value=config),\
                 patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value='{"Service":"hermes","State":"running","Health":"healthy"}\n'),\
                 patch.object(monitoring.API,'call',side_effect=ConnectionError('private failure')):
                result=monitoring.status(state)
            self.assertEqual(result['archive'],{'unavailable':True})
            routes={row['part']:row for row in result['routes']}
            self.assertEqual((routes['reply']['provider_name'],routes['reply']['model'],routes['reply']['configured']),('Synthetic gateway','synthetic-model',True))
            self.assertEqual((routes['memory']['provider'],routes['memory']['configured']),('',False))
            self.assertEqual(routes['embedding']['provider'],'openai')
            self.assertEqual(result['telegram_incident']['error_code'],'telegram_network_error')
            keys={row['name']:row for row in result['keys']}
            self.assertEqual((keys['SERVICE_TOKEN']['service'],keys['SERVICE_TOKEN']['present']),('Nocheh services',True))
            self.assertFalse(keys['INNGEST_SIGNING_KEY']['present'])
            self.assertTrue(all(row['usage'] for row in result['keys']))
            self.assertNotIn('private',json.dumps(result))
