"""Pinned native dashboard shell, with no agent/gateway or credential lifecycle."""
import contextlib
import os
from pathlib import Path

READ_APIS = {'/api/dashboard/plugins', '/api/dashboard/themes', '/api/dashboard/font',
             '/api/config', '/api/profiles', '/api/status', '/api/auth/me'}


class RestrictedDashboard:
    def __init__(self, app): self.app = app

    async def __call__(self, scope, receive, send):
        from starlette.responses import JSONResponse
        if scope['type'] == 'websocket':
            await send({'type': 'websocket.close', 'code': 1008}); return
        if scope['type'] == 'http':
            path = scope['path']
            presentation_write = scope['method'] == 'PUT' and path in ('/api/dashboard/theme', '/api/dashboard/font')
            if not presentation_write and (scope['method'] != 'GET' or (path.startswith('/api/') and path not in READ_APIS)):
                await JSONResponse({'error': 'managed_by_nocheh'}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def main():
    home = Path(os.environ['HERMES_HOME']); home.mkdir(parents=True, exist_ok=True)
    # This home contains dashboard presentation only, never native runtime state.
    if not (home / 'config.yaml').exists():
        (home / 'config.yaml').write_text('plugins:\n  enabled: [nocheh]\nmemory:\n  provider: ""\n')
    plugins = home / 'plugins'; plugins.mkdir(exist_ok=True)
    target = plugins / 'nocheh'
    if not target.exists(): target.symlink_to(Path(__file__).parent)
    os.environ['HERMES_DASHBOARD_SESSION_TOKEN'] = Path('/dashboard-state/token').read_text().strip()
    from hermes_cli import web_server as native
    @contextlib.asynccontextmanager
    async def lifespan(app): yield
    native.app.router.lifespan_context = lifespan
    native._DASHBOARD_EMBEDDED_CHAT_ENABLED = True  # UI only; managed PTYs live in the runtime admin service.
    native.app.state.bound_host = '127.0.0.1'
    import uvicorn
    uvicorn.run(RestrictedDashboard(native.app), host='0.0.0.0', port=9119,
                access_log=False, log_level='warning')


if __name__ == '__main__': main()
