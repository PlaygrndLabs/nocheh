import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from .security_launcher import container_spec,validate_local_profile,docker,attach
from .security_transport import scoped_transport,isolated_enabled
from .isolated_profile import prepare,database_path,DATA_DIRS

class SecurityTests(unittest.TestCase):
    def test_no_ambient_authority_in_container(self):
        spec=container_spec('nocheh-'+'a'*24,'/owned/profiles','sha256:'+'b'*64,'nocheh-agent',1000,1000)
        host=spec['HostConfig'];encoded=json.dumps(spec)
        for value in ['SERVICE_TOKEN','TELEGRAM_BOT_TOKEN','api_key','docker.sock','/auth','network=host']:self.assertNotIn(value,encoded)
        self.assertEqual(host['CapDrop'],['ALL']);self.assertTrue(host['ReadonlyRootfs']);self.assertEqual(host['Dns'],['127.0.0.1'])
        self.assertEqual([Path(m['Source']).name for m in host['Mounts'] if not m['ReadOnly']],list(DATA_DIRS))
        self.assertFalse(any(m['Target']=='/profile' for m in host['Mounts']))
        with self.assertRaises(ValueError):container_spec('../private','/owned','sha256:'+'b'*64,'nocheh-agent',1000,1000)
        with self.assertRaises(ValueError):container_spec('nocheh-'+'a'*24,'relative','tag','nocheh-agent',0,0)
    def test_data_preservation_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);profile=root/('nocheh-'+'a'*24);profile.mkdir();(profile/'config.yaml').write_text('{}')
            (profile/'state.db').write_bytes(b'existing history')
            with self.assertRaisesRegex(ValueError,'conversion_required'):prepare(profile)
            self.assertEqual((profile/'state.db').read_bytes(),b'existing history')
            (profile/'state.db').unlink();prepare(profile);validate_local_profile(profile.name,root)
            self.assertEqual(database_path(profile),profile/'native-state'/'state.db')
            (profile/'native-state'/'state.db').symlink_to('/private/secret')
            with self.assertRaisesRegex(ValueError,'session_path_denied'):database_path(profile)
    def test_no_unknown_mode_or_transport_fallback(self):
        with patch.dict(os.environ,NOCHEH_SECURITY_RUNTIME='broken'):
            with self.assertRaises(ValueError):isolated_enabled()
        self.assertEqual(scoped_transport('turn.capability','codex_responses')['api_key'],'turn.capability')
        with self.assertRaises(ValueError):scoped_transport('turn.capability','bedrock')

    @unittest.skipUnless(os.environ.get('NOCHEH_TEST_DOCKER')=='1','explicit isolated Docker fixture required')
    def test_real_container_cannot_reach_secrets_siblings_or_internet(self):
        network='nocheh-security-fixture';created=False;identifier=None
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]/'data') as folder:
            root=Path(folder);name='nocheh-'+'d'*24;profile=root/name;profile.mkdir();(profile/'config.yaml').write_text('{}');prepare(profile)
            try:
                docker('POST','/networks/create',{'Name':network,'Internal':True});created=True
                image=docker('GET','/images/nocheh-hermes:local/json')['Id']
                spec=container_spec(name,str(root),image,network,os.getuid(),os.getgid())
                code='''import os,socket,sys,json
from pathlib import Path
body=json.load(sys.stdin)
assert body['text']=='exact synthetic context'
assert not Path('/var/run/docker.sock').exists()
assert not Path('/workspace/data/local/hermes/auth.json').exists()
assert not Path('/run/secrets/cliproxy_hermes_key').exists()
assert not any(k in os.environ for k in ('SERVICE_TOKEN','TELEGRAM_BOT_TOKEN','OPENAI_API_KEY'))
try: Path('/profile/config.yaml').write_text('changed');raise AssertionError('configuration writable')
except OSError: pass
Path('/profile/memories/MEMORY.md').write_text('Exact memory 😃\\n')
for address in [('1.1.1.1',443),('172.17.0.1',80)]:
 try:
  socket.create_connection(address,timeout=1).close();raise AssertionError('network escape')
 except OSError: pass
try: socket.getaddrinfo('example.com',443);raise AssertionError('external DNS allowed')
except OSError: pass
print(json.dumps({'state':'done','text':'isolated'}))
'''
                spec['Cmd']=['python','-c',code]
                identifier=docker('POST','/containers/create',spec)['Id']
                result=b''.join(attach(identifier,{'text':'exact synthetic context'}))
                self.assertEqual(json.loads(result)['text'],'isolated')
                self.assertEqual((profile/'memories'/'MEMORY.md').read_text(),'Exact memory 😃\n')
            finally:
                if identifier:docker('DELETE','/containers/'+identifier+'?force=true')
                if created:docker('DELETE','/networks/'+network)

if __name__=='__main__':unittest.main()
