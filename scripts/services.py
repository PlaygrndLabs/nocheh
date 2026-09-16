"""Owner-facing service names, responsibilities and expected lifecycle states."""
import json
import subprocess
import time
from pathlib import Path

# name, tool, purpose, location, lifecycle/profile
CATALOG=(
 ('nocheh-dashboard','Nocheh','Owner dashboard, configuration, backup and recovery','docker','running'),
 ('nocheh-executor','Nocheh + Inngest','Imports, approved tools and durable receipt recovery','docker','running'),
 ('nocheh-app','Nocheh + Inngest SDK','API, capture, event publication and ordinary workflows','docker','running'),
 ('nocheh-postgres','PostgreSQL','Separate Nocheh and Inngest databases and roles','docker','running'),
 ('nocheh-security','Nocheh','Security broker, guard and exact authorization checks','docker','running'),
 ('hermes-runtime','Hermes','Managed reasoning runtime and native dashboard','docker','running'),
 ('hermes-agent-launcher','Hermes','Launch isolated agent containers','docker','running'),
 ('chatgpt-speech','codex-asr','Subscription transcription with read-only provider login','docker','running'),
 ('cliproxy-api','CLIProxyAPI','Shared model provider and sole login refresh authority','docker','running'),
 ('cliproxy-monitor','CPA Manager Plus','Persistent provider history, usage and analytics','docker','running'),
 ('inngest-server','Inngest','Workflow scheduling, retries, waits and inspection UI','docker','running'),
 ('inngest-redis','Redis','Durable workflow queue and run state','docker','running'),
 ('honcho-api','Honcho','Memory API','docker','honcho'),
 ('honcho-deriver','Honcho','Internal memory derivation; metrics probe checks process availability','docker','honcho'),
 ('honcho-postgres','PostgreSQL + pgvector','Memory, vectors and derivation jobs','docker','honcho'),
 ('honcho-redis','Redis','Honcho memory cache','docker','honcho'),
 ('honcho-provider-gateway','Honcho / Nocheh','Controlled provider access and embedding spending records','docker','honcho'),
 ('pgweb-archive','pgweb','Optional read-only archive inspection','docker','optional'),
 ('honcho-cli','Honcho CLI','Optional one-shot memory inspection','docker','optional'),
)


def containers(command,env):
    raw=subprocess.check_output(command+['ps','--all','--format','json'],env=env,text=True,stderr=subprocess.DEVNULL,timeout=10)
    rows=json.loads(raw) if raw.lstrip().startswith('[') else [json.loads(line) for line in raw.splitlines() if line]
    return [{'service':row.get('Service'),'state':row.get('State'),'health':row.get('Health'),'exit_code':row.get('ExitCode')} for row in rows]


def describe(rows,config,host=None):
    observed={row['service']:row for row in rows};host=host or {};result=[]
    for name,tool,purpose,location,lifecycle in CATALOG:
        expected='optional-stopped' if lifecycle=='optional' or lifecycle=='honcho' and config.get('NOCHEH_HONCHO_ENABLED')!='true' else 'completed' if lifecycle=='completed' else 'running'
        row=host.get(name,{}) if location=='host' else observed.pop(name,{})
        actual=row.get('state','stopped');health=row.get('health')
        if actual=='running':state='unhealthy' if health in ('unhealthy','starting') else 'running'
        elif actual=='exited' and row.get('exit_code')==0 and expected in ('completed','optional-stopped'):state='completed'
        elif expected=='optional-stopped':state='optional-stopped'
        else:state='unhealthy'
        result.append({'service':name,'tool':tool,'purpose':purpose,'location':location,'expected_state':expected,'state':state,'process_state':actual,'health':health})
    for row in observed.values():
        result.append({**row,'tool':'Previous deployment','purpose':'Obsolete service; remove after verified cutover','location':'docker','expected_state':'optional-stopped','state':'unhealthy' if row['state']=='running' else 'optional-stopped'})
    return result


def host_status(state):
    # Management is observed through Compose, including from the host CLI.
    return {}
