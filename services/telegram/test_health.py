"""Polling health and its error ladder: what restarts the service, what stops it, and what health shows meanwhile."""
import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from telegram.error import Conflict, InvalidToken, NetworkError

from .gateway import TelegramService
from .poller import CONFLICT_RETRIES, NETWORK_FAILURES, Poller
from .settings import Policy


class Bot:
    def __init__(self, error):
        self.error, self.polls = error, 0
    async def initialize(self): pass
    async def get_me(self): return SimpleNamespace(id=123456, username='synthetic_fixture_bot', first_name='Synthetic')
    async def delete_webhook(self, drop_pending_updates): assert drop_pending_updates is False
    async def get_my_commands(self, scope): return []
    async def get_updates(self, **options):
        self.polls += 1
        raise self.error


class HealthTests(unittest.IsolatedAsyncioTestCase):
    def service(self, folder, restarts):
        service = TelegramService(Policy(True, '123', [], {}), '123456:secret-token', Path(folder) / 'spool', Path(folder) / 'state',
                                  lambda: restarts.append(True))
        service.capture = SimpleNamespace(polling={'last_poll_at': None, 'error_code': None})
        return service

    async def ladder(self, error):
        with tempfile.TemporaryDirectory() as folder:
            restarts, waits = [], []
            service = self.service(folder, restarts)
            service.bot = Bot(error)
            async def sleep(seconds): waits.append(seconds)
            await asyncio.wait_for(Poller(service, sleep).run(), 5)
            incident = (Path(folder) / 'state/telegram-incident.json').read_text()
            return service, restarts, waits, incident

    async def test_network_failures_back_off_then_hand_over_to_one_restart_with_a_safe_incident(self):
        service, restarts, waits, incident = await self.ladder(NetworkError('connection refused for 123456:secret-token'))
        self.assertEqual(service.bot.polls, NETWORK_FAILURES)
        self.assertEqual(waits, [5, 10, 20, 40, 60, 60, 60, 60, 60])
        self.assertEqual(restarts, [True])
        self.assertNotIn('secret-token', incident)
        self.assertEqual((json.loads(incident)['state'], json.loads(incident)['error_code']), ('failed', 'telegram_network_error'))
        self.assertEqual(service.health()['state'], 'failed')

    async def test_another_poller_is_waited_out_then_stops_without_restart(self):
        service, restarts, waits, incident = await self.ladder(Conflict('terminated by other getUpdates request'))
        self.assertEqual(service.bot.polls, CONFLICT_RETRIES + 1)
        self.assertEqual(restarts, [], 'a restart would only meet the other poller again')
        self.assertEqual(json.loads(incident)['error_code'], 'telegram_polling_conflict')

    async def test_a_wrong_token_stops_at_once(self):
        service, restarts, waits, incident = await self.ladder(InvalidToken())
        self.assertEqual((service.bot.polls, waits, restarts), (1, [], []))
        self.assertEqual(service.health()['error_code'], 'invalid_token')

    def test_connected_needs_a_recent_poll(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(folder, [])
            service.status = 'connected'
            self.assertEqual(service.health()['state'], 'recovering')
            service.capture.polling['last_poll_at'] = datetime.now(timezone.utc).isoformat()
            self.assertEqual(service.health()['state'], 'connected')
            service.capture.polling['last_poll_at'] = (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat()
            self.assertEqual(service.health()['state'], 'recovering')

    def test_one_failed_poll_still_lets_replies_go_out(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(folder, [])
            service.bot = object()
            for status, connected in (('connected', True), ('recovering', True), ('starting', False), ('stopped', False)):
                service.status = status
                self.assertEqual(service.connected(), connected, status)


class ServerTests(unittest.TestCase):
    def test_health_names_the_service_and_routes_need_the_service_token(self):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer
        from . import server
        with tempfile.TemporaryDirectory() as folder, patch.object(server, 'TOKEN', 't' * 32), \
                patch.object(server, 'SERVICE', TelegramService(Policy(False, None, [], {}), '', Path(folder) / 'spool', Path(folder) / 'state')):
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def call(method, path, body=None, token=None):
                    connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
                    connection.request(method, path, body=json.dumps(body) if body is not None else None,
                                       headers={'Authorization': 'Bearer ' + token} if token else {})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                self.assertEqual(call('GET', '/health'), (200, {'ok': True, 'service': 'telegram', 'telegram': 'disabled',
                                                                'telegram_details': {'state': 'disabled', 'error_code': None}}))
                self.assertEqual(call('POST', '/internal/telegram/identity', {})[0], 401)
                self.assertEqual(call('POST', '/internal/telegram/identity', {}, 't' * 32), (200, {'state': 'disabled'}))
                self.assertEqual(call('POST', '/internal/telegram/reply', {'id': 'x'}, 't' * 32), (400, {'error': 'invalid_request'}))
                with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN': ''}):
                    self.assertEqual(call('POST', '/internal/telegram/file', {'file_id': 'a'}, 't' * 32), (503, {'error': 'telegram_unavailable'}))
            finally:
                httpd.shutdown()


if __name__ == '__main__':
    unittest.main()
