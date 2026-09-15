"""Keep native dashboard preferences separate from runtime/profile configuration."""
from pathlib import Path
from .profile_config import read, atomic_yaml

READ_APIS={'/api/dashboard/plugins','/api/dashboard/themes','/api/dashboard/font','/api/auth/me'}
WRITE_APIS={'/api/dashboard/theme','/api/dashboard/font'}


def presentation_route(path,method):
    return (method in ('GET','HEAD') and (not path.startswith('/api/') or path in READ_APIS)
            or method=='PUT' and path in WRITE_APIS)


def install(home):
    """Bind only dashboard helpers; never change the process/runtime HERMES_HOME."""
    from hermes_cli.web_routers import dashboard_ui
    from hermes_cli import web_server_dashboard
    from hermes_cli import web_server
    home=Path(home);home.mkdir(parents=True,exist_ok=True,mode=0o700)
    config=home/'config.yaml'
    if not config.exists():atomic_yaml(config,{'plugins':{'enabled':['nocheh']},'memory':{'provider':''}})
    plugins=home/'plugins';plugins.mkdir(exist_ok=True,mode=0o700)
    target=plugins/'nocheh'
    if not target.exists():target.symlink_to(Path(__file__).parent)
    dashboard_ui.load_config=lambda:read(config)
    dashboard_ui.save_config=lambda value:atomic_yaml(config,value)
    web_server_dashboard.get_process_hermes_home=lambda:home
    web_server._dashboard_plugins_cache=None
    def enabled():
        values=read(config).get('plugins',{})
        return set(values.get('enabled',[])),set(values.get('disabled',[]))
    dashboard_ui._plugin_enable_sets=enabled
