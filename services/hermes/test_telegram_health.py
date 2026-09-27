import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from .assistant_gateway import AssistantGateway
from .scopes import Scopes


class TelegramHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_fatal_native_polling_requests_one_restart_and_records_safe_incident(self):
        with tempfile.TemporaryDirectory() as folder:
            restarts=[]
            gateway=AssistantGateway(folder,Path(folder)/'spool',Scopes({'enabled':True,'owner_id':'123','group_ids':[]}),
                                     'fixture','fixture',lambda:None,lambda:restarts.append(True))
            gateway.status='connected'
            gateway.adapter=SimpleNamespace(has_fatal_error=True,fatal_error_code='telegram_network_error',
                                           fatal_error_message='never expose this token',fatal_error_retryable=True)
            self.assertEqual(gateway.health()['state'],'failed')
            await asyncio.wait_for(gateway.supervise(),1)
            gateway.failed()
            self.assertEqual(restarts,[True])
            incident=(Path(folder)/'telegram-incident.json').read_text()
            self.assertNotIn('token',incident)
            self.assertEqual(json.loads(incident)['error_code'],'telegram_network_error')

    async def test_polling_progress_is_required_and_nonretryable_failure_does_not_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            restarts=[]
            gateway=AssistantGateway(folder,Path(folder)/'spool',Scopes({'enabled':True,'owner_id':'123','group_ids':[]}),
                                     'fixture','fixture',lambda:None,lambda:restarts.append(True))
            gateway.status='connected'
            gateway.adapter=SimpleNamespace(has_fatal_error=False,send_path_degraded=False,
                _app=SimpleNamespace(updater=SimpleNamespace(running=True)),capture=SimpleNamespace(polling={'last_poll_at':None}))
            self.assertEqual(gateway.health()['state'],'recovering')
            gateway.adapter.capture.polling['last_poll_at']=datetime.now(timezone.utc).isoformat()
            self.assertEqual(gateway.health()['state'],'connected')
            gateway.adapter.capture.polling['last_poll_at']=(datetime.now(timezone.utc)-timedelta(minutes=3)).isoformat()
            self.assertEqual(gateway.health()['state'],'recovering')
            gateway.adapter.has_fatal_error=True;gateway.adapter.fatal_error_retryable=False
            gateway.failed()
            self.assertEqual(restarts,[])
