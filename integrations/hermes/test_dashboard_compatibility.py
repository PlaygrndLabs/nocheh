"""Offline checks against the pinned upstream dashboard contract."""
import unittest


class DashboardCompatibilityTests(unittest.TestCase):
    def test_native_dashboard_token_gate_and_extension_contract(self):
        from fastapi import APIRouter
        from fastapi.testclient import TestClient
        from hermes_cli import web_server as server
        from hermes_cli.web_server_dashboard import _plugin_api_mount_skip_reason
        router = APIRouter()
        @router.get('/api/plugins/nocheh-probe/check')
        def check(): return {'ok': True}
        server.app.include_router(router)
        client = TestClient(server.app)  # No lifespan: no gateway/background work.
        self.assertEqual(client.get('/api/plugins/nocheh-probe/check').status_code, 401)
        self.assertEqual(client.get('/api/config', headers={
            'X-Hermes-Session-Token': server._SESSION_TOKEN}).status_code, 200)
        self.assertIsNone(_plugin_api_mount_skip_reason(
            {'name': 'nocheh', 'source': 'user'}, {'nocheh'}, set()))
        self.assertIsNotNone(_plugin_api_mount_skip_reason(
            {'name': 'nocheh', 'source': 'user'}, set(), set()))
