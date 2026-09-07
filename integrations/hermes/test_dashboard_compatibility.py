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

    def test_restricted_shell_rejects_native_agent_and_mutation_routes(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from .dashboard_server import RestrictedDashboard
        app=FastAPI(); calls=[]
        @app.api_route('/{path:path}',methods=['GET','POST','PUT','DELETE'])
        def backend(path):calls.append(path);return {'ok':True}
        client=TestClient(RestrictedDashboard(app))
        for method,path in [('POST','/api/gateway/start'),('PUT','/api/config'),('GET','/api/pty'),
                            ('GET','/api/env'),('GET','/api/files'),('POST','/api/plugins/other/action')]:
            self.assertEqual(client.request(method,path).status_code,403)
        self.assertFalse(calls)
        self.assertEqual(client.get('/api/dashboard/plugins').status_code,200)
