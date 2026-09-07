"""Experiment-only egress: subscription reasoning and strictly budgeted embeddings."""
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = 'text-embedding-3-small'
REASONING_MODEL = 'gpt-5.6-sol'
LIMIT_MICRODOLLARS = 5_000_000
RESERVATION = 10_000  # $0.01; never released, including unknown/failed requests.
PRICE_PER_MILLION = 0.02  # USD, reviewed 2026-09-07; see README.


class Rejected(Exception):
    pass


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, route TEXT, digest TEXT, reserved INTEGER, started REAL, status INTEGER, duration_ms INTEGER, usage TEXT)')

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.execute('PRAGMA synchronous=FULL')
        return db

    def reserve(self, route, body):
        amount = RESERVATION if route == '/v1/embeddings' else 0
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            total, count = db.execute('SELECT coalesce(sum(reserved),0),count(*) FROM calls').fetchone()
            if total + amount > LIMIT_MICRODOLLARS or count >= 1500:
                raise Rejected('experiment_budget_exhausted')
            return db.execute('INSERT INTO calls(route,digest,reserved,started) VALUES(?,?,?,?)',
                (route, hashlib.sha256(body).hexdigest(), amount, time.time())).lastrowid

    def finish(self, call, status, duration, usage):
        with self.connect() as db:
            db.execute('UPDATE calls SET status=?,duration_ms=?,usage=? WHERE id=?',
                (status, round(duration*1000), json.dumps(usage), call))

    def report(self):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            calls = [dict(row) for row in db.execute('SELECT * FROM calls ORDER BY id')]
        return {'limit_usd': 5, 'reserved_usd': sum(c['reserved'] for c in calls)/1e6,
                'pricing_usd_per_million_embedding_tokens': PRICE_PER_MILLION,
                'note': 'Reservations are conservative, not a provider invoice; unfinished calls remain reserved.', 'calls': calls}


def validate(route, payload):
    if not isinstance(payload, dict):
        raise Rejected('object_required')
    if route == '/v1/embeddings':
        if set(payload) - {'model', 'input', 'dimensions', 'encoding_format'}:
            raise Rejected('embedding_fields_denied')
        if payload.get('model') != MODEL or payload.get('dimensions',1536) != 1536:
            raise Rejected('embedding_model_denied')
        value = payload.get('input')
        def size(item):
            if isinstance(item,str): return len(item.encode('utf-8'))
            if isinstance(item,list) and item and all(type(n) is int and 0 <= n < 300000 for n in item): return len(item)
            raise Rejected('embedding_input_denied')
        if isinstance(value,str) or (isinstance(value,list) and value and type(value[0]) is int): bound=size(value)
        elif isinstance(value,list) and 0 < len(value) <= 100: bound=sum(size(v) for v in value)
        else: raise Rejected('embedding_input_denied')
        # UTF-8 bytes bound token count for the allowed tokenizer. At the pinned
        # price this costs at most $0.002622, below the $0.01 reservation.
        if not 0 < bound <= 131072: raise Rejected('embedding_bound_exceeded')
        if payload.get('encoding_format','float') not in ('float','base64'): raise Rejected('encoding_denied')
    elif route == '/v1/chat/completions':
        if payload.get('model') != REASONING_MODEL: raise Rejected('reasoning_model_denied')
        if not isinstance(payload.get('messages'),list): raise Rejected('messages_required')
        for field in ('max_tokens','max_completion_tokens'):
            if field in payload and (type(payload[field]) is not int or not 0 < payload[field] <= 4096): raise Rejected('output_bound_exceeded')
        if not any(k in payload for k in ('max_tokens','max_completion_tokens')): payload['max_completion_tokens']=4096
    else: raise Rejected('route_denied')
    return payload


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class Egress:
    def __init__(self, ledger, token, paid_key, opener=None):
        self.ledger,self.token,self.paid_key = ledger,token,paid_key
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def send(self, route, payload):
        payload=validate(route,payload)
        paid=route=='/v1/embeddings'
        if paid and not self.paid_key: raise Rejected('temporary_embedding_key_missing')
        data=json.dumps(payload,ensure_ascii=False).encode()
        if len(data)>1024*1024: raise Rejected('request_too_large')
        call=self.ledger.reserve(route,data)  # fsync transaction BEFORE any egress
        start=time.monotonic();status=502;usage=None
        url=('https://api.openai.com'+route) if paid else ('http://bridge:8317'+route)
        try:
            request=urllib.request.Request(url,data=data,headers={'Authorization':'Bearer '+(self.paid_key if paid else self.token),'Content-Type':'application/json'})
            with self.opener.open(request,timeout=180) as response:
                status=response.status;content=response.read(16*1024*1024+1)
                if len(content)>16*1024*1024: raise Rejected('response_too_large')
                kind=response.headers.get('Content-Type','application/json')
            try:
                if 'event-stream' in kind:
                    for line in content.splitlines():
                        if line.startswith(b'data: ') and line != b'data: [DONE]':
                            candidate=json.loads(line[6:]).get('usage')
                            if candidate: usage=candidate
                else: usage=json.loads(content).get('usage')
            except (ValueError,AttributeError): pass
            return status,kind,content
        except urllib.error.HTTPError as error:
            status=error.code
            return status,'application/json',json.dumps({'error':{'message':'experiment_upstream_rejected','code':status}}).encode()
        except Exception:
            status=502
            return 502,'application/json',b'{"error":{"message":"experiment_upstream_unavailable"}}'
        finally:
            self.ledger.finish(call,status,time.monotonic()-start,usage)


def handler(egress):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self,status,kind,body):
            self.send_response(status);self.send_header('Content-Type',kind)
            self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def do_GET(self):
            if self.path=='/health': return self.respond(200,'application/json',b'{"ok":true}')
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+egress.token): return self.respond(401,'application/json',b'{}')
            if self.path!='/ledger': return self.respond(404,'application/json',b'{}')
            self.respond(200,'application/json',json.dumps(egress.ledger.report()).encode())
        def do_POST(self):
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+egress.token): return self.respond(401,'application/json',b'{}')
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0 < length <= 1024*1024 or self.headers.get('Transfer-Encoding'): raise Rejected('request_bound_exceeded')
                status,kind,body=egress.send(self.path,json.loads(self.rfile.read(length)))
            except (Rejected,ValueError) as error:
                status,kind,body=403,'application/json',json.dumps({'error':{'message':str(error) if isinstance(error,Rejected) else 'invalid_json'}}).encode()
            self.respond(status,kind,body)
    return Handler


if __name__=='__main__':
    token=Path('/state/internal_token').read_text().strip()
    paid=Path('/run/secrets/temporary_embedding_key').read_text().strip()
    if not token: raise SystemExit('internal_token_missing')
    ThreadingHTTPServer(('0.0.0.0',8790),handler(Egress(Ledger('/ledger/budget.sqlite'),token,paid))).serve_forever()
