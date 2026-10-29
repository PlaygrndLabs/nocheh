"""Read-only owner monitoring. No source text, credentials or provider bodies."""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from tools.operations.installation.configuration import load, compose
from tools.operations.provider import routes as provider_routes
from tools.operations.archive.archive import API
from tools.operations.installation.services import containers,describe,host_status


# Keys Nocheh generates for its own services. Provider keys are listed under Settings › Models.
INTERNAL_KEYS = (
    ('SERVICE_TOKEN', 'Nocheh services', 'Lets Nocheh’s own services and the dashboard call each other'),
    ('INNGEST_EVENT_KEY', 'Background work (Inngest)', 'Sends new background work to Inngest'),
    ('INNGEST_SIGNING_KEY', 'Background work (Inngest)', 'Proves that a call from Inngest is genuine'),
    ('POSTGRES_PASSWORD', 'Database', 'Database administrator login, used for setup and backups'),
    ('INNGEST_POSTGRES_PASSWORD', 'Database', 'Inngest’s own database login'),
    ('NOCHEH_ARCHIVE_PASSWORD', 'Database', 'Login for the store of original messages'),
    ('NOCHEH_DERIVED_PASSWORD', 'Database', 'Login for the store of transcripts and assistant copies'),
    ('NOCHEH_CONTROL_PASSWORD', 'Database', 'Login for the store of settings, approvals and work'),
    ('NOCHEH_MEMORY_TOKEN', 'Long-term memory (Honcho)', 'Lets Honcho’s model calls pass Nocheh’s secret check'),
)


def internal_keys(config):
    """Which internal key each service uses and whether it is set; never a value."""
    return [{'name': name, 'service': service, 'usage': usage, 'present': bool(config.get(name))}
            for name, service, usage in INTERNAL_KEYS]


def status(state):
    config=load(state)
    command,env=compose(state)
    def attempt(fn):
        try:return fn()
        except Exception:return {'unavailable':True}
    with ThreadPoolExecutor(max_workers=6) as executor:
        jobs={name:executor.submit(attempt,fn) for name,fn in {
            'archive':lambda:API().call('/v1/status',timeout=5), 'runtime':lambda:API().call('/v1/runtime',timeout=5),
            'containers':lambda:containers(command,env),'hosts':lambda:host_status(state),
            'application':lambda:API().call('/health',timeout=5),
            'workflows':lambda:API().call('/v1/workflows/health',timeout=5)}.items()}
        result={name:future.result() for name,future in jobs.items()}
    result['services']=describe(result['containers'],config,result['hosts']) if isinstance(result['containers'],list) else None
    result['routes']=attempt(lambda:routes(config))
    result['model_problems']=attempt(lambda:model_problems(state))
    result['keys']=internal_keys(config)
    result['checked_at']=datetime.now(timezone.utc).isoformat()
    result['telegram_enabled']=config.get('TELEGRAM_ENABLED')=='true'
    # Preserve the last known fatal incident even after its replacement is healthy.
    result['telegram_incident']=None
    try:
        path=Path(state)/'hermes/telegram-incident.json'
        if path.exists():
            data=json.loads(path.read_text())
        else:
            data=json.loads((Path(state)/'hermes/gateway_state.json').read_text()).get('platforms',{}).get('telegram',{})
        if data.get('state') in ('fatal','failed'):
            code=data.get('error_code')
            result['telegram_incident']={'at':data.get('recorded_at',data.get('updated_at')),
                'error_code':code if code in ('telegram_network_error','telegram_polling_conflict','telegram_adapter_failed','invalid_token','missing_credentials') else 'telegram_adapter_failed'}
    except (OSError,ValueError,TypeError):pass
    return result


def routes(config):
    """Which provider and model each part uses; never a key."""
    known=provider_routes.providers(config)
    selected=[*provider_routes.routes(config).values(),provider_routes.embedding_route(config),provider_routes.transcription_route(config)]
    labels={**{part:label for part,(label,_,_) in provider_routes.PARTS.items()},'embedding':'Memory search','transcription':'Voice notes'}
    # Voice notes without their provider's key are archived only.
    ready=lambda route:route.configured and (route.part!='transcription' or bool(route.key))
    return [{'part':route.part,'label':labels[route.part],'provider':route.provider,
             'provider_name':known[route.provider]['name'] if route.configured else '',
             'model':route.model if route.configured else '','configured':ready(route)} for route in selected]


def model_problems(state, now=None):
    """Today's failed, refused and hidden model calls per part and model, with why they failed, from the usage tracker."""
    from tools.operations.provider import problems, usage
    day=(now or datetime.now(timezone.utc)).strftime('%Y-%m-%d')
    rows=(usage.hermes_rows(state,day) or [])+(usage.honcho_rows(state,day) or [])
    return [{'day':day,'part':row['part'],'label':usage.PARTS.get(row['part'],(row['part'],))[0],'provider':row['provider'],
             'model':row['model'],'calls':row['calls'],'failed':row['failed'],'refused':row.get('refused') or 0,'hidden':row.get('hidden') or 0,
             'reasons':row.get('reasons') or {},'why':problems.why(row)}
            for row in rows if row['day']==day and (row['failed'] or row.get('hidden'))]
