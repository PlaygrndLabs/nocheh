"""Read-only owner monitoring. No source text, credentials or provider bodies."""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from .configuration import load
from .provider import status as provider_status, compose
from .archive import API


def status(state):
    config=load(state)
    command,env=compose(state)
    def containers():
        raw=subprocess.check_output(command+['ps','--format','json'],env=env,text=True,stderr=subprocess.DEVNULL,timeout=10)
        return [{key:row.get(source) for key,source in [('service','Service'),('state','State'),('health','Health')]} for row in map(json.loads,raw.splitlines()) if row]
    def attempt(fn):
        try:return fn()
        except Exception:return {'unavailable':True}
    with ThreadPoolExecutor(max_workers=5) as executor:
        jobs={name:executor.submit(attempt,fn) for name,fn in {
            'archive':lambda:API().call('/v1/status',timeout=5), 'runtime':lambda:API().call('/v1/runtime',timeout=5),
            'provider':lambda:provider_status(state),'containers':containers,
            'workflows':lambda:API().call('/v1/workflows/health',timeout=5)}.items()}
        result={name:future.result() for name,future in jobs.items()}
    provider=result['provider'];provider.pop('root',None)
    result['checked_at']=datetime.now(timezone.utc).isoformat()
    result['telegram_enabled']=config.get('TELEGRAM_ENABLED')=='true'
    result['saved_reasoning_route']=config.get('NOCHEH_REASONING_ROUTE','native')
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
