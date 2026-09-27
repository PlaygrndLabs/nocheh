"""Isolated speech boundary with read-only access to CLIProxyAPI's Codex login."""
from __future__ import annotations

import hmac
import json
import os
import re
import signal
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .environment import secret
from .transcription import MAX_AUDIO, run_asr, safe_failure

TOKEN = secret('SERVICE_TOKEN')
AUTH_DIR = Path(os.environ.get('CLIPROXY_AUTH_DIR','/provider-auth'))
SUFFIXES = {'.ogg','.oga','.mp3','.wav','.m4a','.mp4','.flac'}


def access_token():
    candidates=[]
    for path in AUTH_DIR.glob('*.json'):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024*1024:
            continue
        try: body=json.loads(path.read_text())
        except (OSError,ValueError,UnicodeError): continue
        if not isinstance(body,dict):
            continue
        token=body.get('access_token')
        if body.get('type') == 'codex' and body.get('disabled') is not True and isinstance(token,str) and token.strip():
            candidates.append(token.strip())
    if len(candidates) != 1:
        raise RuntimeError('single_provider_login_required')
    return candidates[0]


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def reply(self,status,data):
        raw=json.dumps(data,separators=(',',':')).encode()
        self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store')
        self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        if self.path!='/health': return self.reply(404,{'error':'not_found'})
        try: access_token();present=True
        except Exception: present=False
        return self.reply(200,{'ok':True,'service':'speech','login_present':present})
    def do_POST(self):
        if self.path!='/transcribe': return self.reply(404,{'error':'not_found'})
        if not hmac.compare_digest(self.headers.get('Authorization','').encode(),('Bearer '+TOKEN).encode()):
            return self.reply(401,{'error':'unauthorized'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            suffix=self.headers.get('X-Nocheh-Suffix','')
            language=self.headers.get('X-Nocheh-Language') or None
            if not 0 < length <= MAX_AUDIO or self.headers.get('Transfer-Encoding') or suffix not in SUFFIXES:
                return self.reply(400,{'error':'invalid_audio'})
            if language and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,31}',language):
                return self.reply(400,{'error':'invalid_language'})
            token=access_token();raw=self.rfile.read(length)
            if len(raw)!=length: return self.reply(400,{'error':'invalid_audio'})
            with tempfile.NamedTemporaryFile(suffix=suffix) as audio:
                audio.write(raw);audio.flush();result=run_asr(Path(audio.name),language,token)
                if result.returncode and safe_failure(result).get('status_code')==401:
                    current=access_token()
                    if current!=token: result=run_asr(Path(audio.name),language,current)
            if result.returncode: return self.reply(200,safe_failure(result))
            body=json.loads(result.stdout);transcript=body.get('text') if isinstance(body,dict) else None
            if not isinstance(transcript,str) or not transcript.strip():
                return self.reply(200,{'success':False,'transcript':'','provider':'nocheh-subscription','error':'invalid_transcription_response','retryable':False})
            return self.reply(200,{'success':True,'transcript':transcript,'provider':'nocheh-subscription'})
        except Exception:
            return self.reply(503,{'success':False,'transcript':'','provider':'nocheh-subscription','error':'transcription_dependency_or_auth_error','retryable':False})


def main():
    if len(TOKEN)<24: raise SystemExit('Service token is missing or too short')
    server=ThreadingHTTPServer(('0.0.0.0',8783),Handler)
    signal.signal(signal.SIGTERM,lambda *_:threading.Thread(target=server.shutdown,daemon=True).start())
    print(json.dumps({'event':'ready','service':'speech'}),flush=True)
    server.serve_forever()


if __name__=='__main__': main()
