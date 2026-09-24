import json
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from . import speech_gateway as gateway


class SpeechGatewayTests(unittest.TestCase):
    def auth(self,root,token='access-one',name='codex.json',**extra):
        path=Path(root)/name
        path.write_text(json.dumps({'type':'codex','access_token':token,**extra}))
        return path

    def test_auth_reader_accepts_exactly_one_enabled_codex_login(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(gateway,'AUTH_DIR',Path(folder)):
            self.auth(folder)
            self.assertEqual(gateway.access_token(),'access-one')
            self.auth(folder,'ignored',name='disabled.json',disabled=True)
            self.assertEqual(gateway.access_token(),'access-one')
            self.auth(folder,'access-two',name='second.json')
            with self.assertRaisesRegex(RuntimeError,'single_provider_login_required'):gateway.access_token()

    def test_audio_uses_current_token_and_retries_only_after_rotation(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(gateway,'AUTH_DIR',Path(folder)):
            auth=self.auth(folder);calls=[]
            def runner(path,language,token):
                calls.append((path.suffix,language,token))
                if len(calls)==1:
                    auth.write_text(json.dumps({'type':'codex','access_token':'access-two'}))
                    return subprocess.CompletedProcess([],1,'','HTTP 401: expired')
                return subprocess.CompletedProcess([],0,json.dumps({'text':'  سلام\r\n  '}),'')
            server=ThreadingHTTPServer(('127.0.0.1',0),gateway.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            request=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/transcribe',data=b'audio',headers={
                'Authorization':'Bearer '+gateway.TOKEN,'Content-Type':'application/octet-stream',
                'X-Nocheh-Suffix':'.ogg','X-Nocheh-Language':'en'})
            try:
                with patch.object(gateway,'run_asr',side_effect=runner),urllib.request.urlopen(request,timeout=3) as response:
                    body=json.load(response)
            finally:
                server.shutdown();server.server_close();thread.join()
            self.assertEqual(body['transcript'],'  سلام\r\n  ')
            self.assertEqual(calls,[('.ogg','en','access-one'),('.ogg','en','access-two')])

    def test_empty_asr_result_is_a_classified_nonretryable_failure(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(gateway,'AUTH_DIR',Path(folder)):
            self.auth(folder)
            server=ThreadingHTTPServer(('127.0.0.1',0),gateway.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            request=urllib.request.Request('http://127.0.0.1:'+str(server.server_port)+'/transcribe',data=b'audio',headers={
                'Authorization':'Bearer '+gateway.TOKEN,'Content-Type':'application/octet-stream','X-Nocheh-Suffix':'.ogg'})
            try:
                with patch.object(gateway,'run_asr',return_value=subprocess.CompletedProcess([],0,json.dumps({'text':''}),'')),urllib.request.urlopen(request,timeout=3) as response:
                    body=json.load(response)
            finally:
                server.shutdown();server.server_close();thread.join()
            self.assertEqual(body['error'],'invalid_transcription_response')
            self.assertFalse(body['retryable'])
            self.assertFalse(body['success'])


if __name__=='__main__':unittest.main()
