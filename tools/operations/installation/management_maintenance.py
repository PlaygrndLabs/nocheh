"""Verify the exact dashboard process coordinating a quiesced backup."""
import hmac,json,re,socket,subprocess
from pathlib import Path
from urllib.request import Request,urlopen

FORMAT='''{"id":{{json .Id}},"started":{{json .State.StartedAt}},"running":{{json .State.Running}},"hostname":{{json .Config.Hostname}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}'''

class ManagementCoordinator:
    def __init__(self,state,environment,identifier,identity):
        self.state=Path(state);self.environment=environment;self.identifier=identifier;self.identity=identity
        self.token=environment.get('NOCHEH_MAINTENANCE_COORDINATOR','')
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',self.token):raise RuntimeError('dashboard_maintenance_required')
        self.assert_current()

    def assert_current(self):
        actual=inspect(self.identifier,self.environment)
        if actual!=self.identity or not actual['running']:raise RuntimeError('dashboard_coordinator_changed')
        token=(self.state/'admin/dashboard/token').read_text().strip()
        port=int(self.environment['NOCHEH_DASHBOARD_PORT'])
        request=Request('http://127.0.0.1:'+str(port)+'/api/nocheh/maintenance',headers={'X-Nocheh-Session-Token':token})
        try:
            with urlopen(request,timeout=5) as response:value=json.load(response)
            if value.get('ready') is not True or not hmac.compare_digest(str(value.get('token','')),self.token):raise ValueError()
        except Exception:raise RuntimeError('dashboard_maintenance_lost') from None

def inspect(identifier,environment):
    return json.loads(subprocess.check_output(['docker','inspect','--format',FORMAT,identifier],env=environment,text=True,stderr=subprocess.DEVNULL))

def coordinating_dashboard(state,command,environment):
    if environment.get('NOCHEH_CONTAINER')!='1':return None
    identifiers=subprocess.check_output(command+['ps','-q','nocheh-dashboard'],env=environment,text=True).split()
    if not identifiers:return None
    if len(identifiers)!=1:raise RuntimeError('ambiguous_dashboard_coordinator')
    identity=inspect(identifiers[0],environment)
    if identity['hostname']!=socket.gethostname():return None
    if identity['service']!='nocheh-dashboard' or not identity['running']:raise RuntimeError('dashboard_coordinator_changed')
    return ManagementCoordinator(state,environment,identifiers[0],identity)
