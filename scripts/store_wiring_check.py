"""Render candidate Compose with synthetic credentials; never start services."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from .configuration import initialize,write_env,env_path,compose_command,compose_environment


def check():
    if os.environ.get('NOCHEH_STORES_FIXTURE')!='1':raise ValueError('synthetic_fixture_opt_in_required')
    with tempfile.TemporaryDirectory(prefix='nocheh-store-wiring-') as temporary:
        state=Path(temporary);values=initialize(state);values['NOCHEH_STORAGE_LAYOUT']='original-only-v1';write_env(env_path(state),values)
        command=compose_command(state,'nocheh-wiring-fixture')
        result=subprocess.run(command+['config','--format','json'],env=compose_environment(state),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        if result.returncode:raise RuntimeError('compose_render_failed')
        services=json.loads(result.stdout)['services'];database=services['nocheh-db']
        assert 'nocheh-store-bootstrap' not in services
        assert database['build']['target']=='store-postgres'
        assert database['environment']['POSTGRES_PASSWORD']==values['POSTGRES_PASSWORD']
        assert database['environment']['NOCHEH_STORAGE_LAYOUT']=='original-only-v1'
        assert database['environment']['INNGEST_POSTGRES_PASSWORD']==values['INNGEST_POSTGRES_PASSWORD']
        for store in ('ARCHIVE','DERIVED','CONTROL'):
            assert database['environment']['NOCHEH_'+store+'_PASSWORD']==values['NOCHEH_'+store+'_PASSWORD']
        assert 'nocheh-stores-ready' in str(database['healthcheck']['test'])
        assert any(mount['target']=='/data/spool' and mount['read_only'] for mount in database['volumes'])
        for name in ('nocheh-app','nocheh-security'):
            env=services[name]['environment'];assert not env.get('PGPASSWORD') and not env.get('PGPASSWORD_FILE')
            assert not env.get('INNGEST_POSTGRES_PASSWORD')
            assert env['NOCHEH_STORAGE_LAYOUT']=='original-only-v1'
            for store in ('ARCHIVE','DERIVED','CONTROL'):
                key='NOCHEH_'+store+'_PASSWORD';assert env[key]==values[key] and env[key]!=values['POSTGRES_PASSWORD']
        assert services['nocheh-app']['depends_on']['nocheh-db']['condition']=='service_healthy'
        marker_mount=[v for v in services['nocheh-security']['volumes'] if v['target']=='/data/spool']
        assert len(marker_mount)==1 and marker_mount[0]['read_only'] is True
        assert services['hermes']['environment']['NOCHEH_STORAGE_LAYOUT']=='original-only-v1'
        assert all('NOCHEH_ARCHIVE_PASSWORD' not in services[name].get('environment',{}) for name in ('hermes','hermes-agent-sb'))
        return {'status':'pass','layout':'original-only-v1','services_started':0,'credentials':'synthetic','runtime_administrator_credentials':False}


if __name__=='__main__':print(json.dumps(check()))
