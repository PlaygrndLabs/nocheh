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
        client = TestClient(server.app,base_url='http://127.0.0.1')  # No lifespan: no gateway/background work.
        self.assertEqual(client.get('/api/plugins/nocheh-probe/check').status_code, 401)
        self.assertEqual(client.get('/api/config', headers={
            'X-Hermes-Session-Token': server._SESSION_TOKEN}).status_code, 200)
        self.assertIsNone(_plugin_api_mount_skip_reason(
            {'name': 'nocheh', 'source': 'user'}, {'nocheh'}, set()))
        self.assertIsNotNone(_plugin_api_mount_skip_reason(
            {'name': 'nocheh', 'source': 'user'}, set(), set()))

    def test_managed_server_rejects_stock_lifecycle_routes(self):
        import tempfile
        from pathlib import Path
        from fastapi.testclient import TestClient
        from .native_admin import create_app
        from .scopes import Scopes
        with tempfile.TemporaryDirectory() as folder:
            from .profile_config import configure_profile
            configure_profile(Path(folder)/'profiles'/Scopes.profile('42'),'gpt-5.6-sol')
            client=TestClient(create_app(Path(folder),'gpt-5.6-sol',Scopes({'enabled':False,'owner_id':'42','group_ids':[]}),'fixture-token'),base_url='http://127.0.0.1')
            for method,path in [('POST','/api/gateway/start'),('GET','/api/env/reveal'),('POST','/api/mcp/test')]:
                self.assertEqual(client.request(method,path,headers={'X-Hermes-Session-Token':'fixture-token'}).status_code,409)

    def test_presentation_preferences_require_the_owner_session(self):
        import tempfile
        from pathlib import Path
        from fastapi.testclient import TestClient
        from .native_admin import create_app
        from .scopes import Scopes
        from .profile_config import read
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            client=TestClient(create_app(root,'gpt-5.6-sol',Scopes({'enabled':False,'owner_id':'42','group_ids':[]}),'fixture-token'),base_url='http://127.0.0.1')
            self.assertEqual(client.put('/api/dashboard/font',json={'font':'system-mono'}).status_code,401)
            self.assertNotIn('dashboard',read(root/'dashboard-presentation/config.yaml'))
            self.assertEqual(client.put('/api/dashboard/font',json={'font':'system-mono'},headers={'X-Hermes-Session-Token':'fixture-token'}).status_code,200)
            self.assertEqual(read(root/'dashboard-presentation/config.yaml')['dashboard']['font'],'system-mono')
