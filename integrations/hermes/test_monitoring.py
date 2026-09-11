import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts import monitoring


class MonitoringTests(unittest.TestCase):
    def test_partial_outage_retains_provider_status_and_safe_telegram_incident(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'hermes').mkdir()
            (state/'hermes/gateway_state.json').write_text(json.dumps({'platforms':{'telegram':{
                'state':'fatal','error_code':'telegram_network_error','error_message':'private token must stay out',
                'updated_at':'2026-09-11T07:04:41Z'}}}))
            with patch.object(monitoring,'load',return_value={'TELEGRAM_ENABLED':'true'}),\
                 patch.object(monitoring,'compose',return_value=(['docker'],{})),\
                 patch.object(monitoring.subprocess,'check_output',return_value='{"Service":"hermes","State":"running","Health":"healthy"}\n'),\
                 patch.object(monitoring,'provider_status',return_value={'login_present':False,'root':'private-path'}),\
                 patch.object(monitoring.API,'call',side_effect=ConnectionError('private failure')):
                result=monitoring.status(state)
            self.assertEqual(result['archive'],{'unavailable':True})
            self.assertFalse(result['provider']['login_present'])
            self.assertEqual(result['telegram_incident']['error_code'],'telegram_network_error')
            self.assertNotIn('private',json.dumps(result))
