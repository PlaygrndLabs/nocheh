import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.provider import monitoring


class MonitoringTests(unittest.TestCase):
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
