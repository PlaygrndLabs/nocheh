"""Exercise setup-only reset snapshots against both real PostgreSQL layouts."""
import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import reset_configuration
from scripts.store_recovery import StoreRecovery

BOOTSTRAP = r'''
import pg from 'pg';
import {initialize} from './dist/src/database.js';
import {initializeStoreDatabases,connectStores} from './dist/src/stores/connections.js';
import {digest,ingest} from './dist/src/archive.js';
const config={host:'nocheh-db',user:'nocheh',database:'nocheh',password:'synthetic-reset-configuration-only'};
const legacy=new pg.Pool(config);await initialize(legacy);
await legacy.query("INSERT INTO memory_spaces(id,overrides) VALUES('-42',$1)",[JSON.stringify({mode:'isolated',sources:['123'],privacy_instructions:'Saved fixture policy'})]);
await ingest(legacy,{version:1,key:'legacy-source',bot_id:'fixture',origin:'live',scope:'123',source_id:'1',revision:'1',kind:'telegram_update',occurred_at:null,text:'SOURCE-CONTENT-LEGACY',payload:{}},false);
const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords);
await stores.control.query("INSERT INTO projects(id,name,description,state,revision) VALUES($1,'Saved project','Saved fixture configuration','archived',1)",['a'.repeat(64)]);
await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES('-42',$1,'assigned',1)",['a'.repeat(64)]);
await stores.control.query("INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision) VALUES($1,'Saved share',$2,'-42',false,'approved','Saved fixture sharing policy',1)",['b'.repeat(64),JSON.stringify(['123'])]);
await stores.control.query("INSERT INTO runtime_profiles(id,name,owner_id,state,revision) VALUES($1,'research','123','active',1)",['profile-'+'c'.repeat(48)]);
await stores.control.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',1,$1,$2)",[JSON.stringify({enabled:true,owner_id:'123',group_ids:['-42']}),digest('configuration')]);
await stores.control.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',1)");
await stores.archive.query("INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,payload,payload_hash,original_text,search_text) VALUES($1,'original-source','telegram','fixture','123','1','1','live','telegram_update',$2,$3,$4,'SOURCE-CONTENT-ORIGINAL')",
 ['d'.repeat(64),Buffer.from('{}'),digest('{}'),Buffer.from('SOURCE-CONTENT-ORIGINAL')]);
await stores.derived.query("INSERT INTO derived_artifacts(id,kind,content,content_hash,provenance,source_revision,input_hash,producer,producer_version,configuration_hash,operation_id,operation_reference) VALUES($1,'runtime_context',$2,$3,'{}','1',$3,'fixture','1',$3,'fixture-content',$4)",
 ['e'.repeat(64),Buffer.from('DERIVED-CONTENT'),digest('DERIVED-CONTENT'),JSON.stringify({store:'control',kind:'operation',id:'fixture',generation:'11111111-1111-4111-8111-111111111111',input_hash:digest('fixture')})]);
await stores.close();await legacy.end();
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--candidate-image', required=True)
    args = parser.parse_args(); directory = args.directory.resolve(); directory.mkdir(mode=0o700)
    project = 'nocheh-reset-configuration-' + uuid.uuid4().hex[:12]
    compose = {'name': project, 'services': {
        'nocheh-db': {'image': 'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'command': ['postgres', '-c', 'cluster_name=nocheh-reset-configuration-fixture'],
            'environment': {'POSTGRES_USER': 'nocheh', 'POSTGRES_DB': 'nocheh', 'POSTGRES_PASSWORD': 'synthetic-reset-configuration-only'},
            'volumes': ['fixture:/var/lib/postgresql/data'],
            'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U nocheh -d nocheh'], 'interval': '2s', 'retries': 30}},
        'checks': {'image': args.candidate_image, 'entrypoint': ['node', '--input-type=module', '-e', BOOTSTRAP],
            'profiles': ['checks'], 'depends_on': {'nocheh-db': {'condition': 'service_healthy'}}}},
        'volumes': {'fixture': {}}, 'networks': {'default': {'internal': True}}}
    file = directory / 'compose.json'; file.write_text(json.dumps(compose))
    command = ['docker', 'compose', '-p', project, '-f', str(file)]; environment = dict(os.environ)
    recovery = StoreRecovery(command, environment)
    try:
        subprocess.run(command + ['up', '-d', '--no-build', '--wait', 'nocheh-db'], check=True)
        subprocess.run(command + ['run', '--rm', '--no-deps', 'checks'], check=True)
        results = {layout: reset_configuration.snapshot(recovery.query, layout) for layout in ('legacy', 'original-only-v1')}
        raw = json.dumps(results)
        assert 'SOURCE-CONTENT' not in raw and 'DERIVED-CONTENT' not in raw
        assert results['legacy']['configuration']['memory_spaces'][0]['overrides']['mode'] == 'isolated'
        original = results['original-only-v1']['configuration']
        assert len(original['projects']) == len(original['project_assignments']) == len(original['sharing_rules']) == len(original['runtime_profiles']) == 1
        assert original['guard_mode'] == [{'mode': 'on'}] and len(original['security_policy']) == 1
        report = {'passed': True, 'project': project, 'layouts': list(results),
                  'configuration_records': {layout: {name: len(rows) for name, rows in value['configuration'].items()} for layout, value in results.items()},
                  'source_or_derivative_content_copied': False, 'network': 'internal only', 'provider_calls': 0, 'live_state_changed': False}
        (directory / 'result.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps(report))
    finally:
        subprocess.run(command + ['down', '--volumes'], check=True)


if __name__ == '__main__': main()
