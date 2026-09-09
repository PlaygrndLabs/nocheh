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
from datetime import datetime, timezone
from contextlib import contextmanager
try:
    from scripts.embedding_config import embeddings
except ModuleNotFoundError:
    from embedding_config import embeddings

MODEL = 'text-embedding-3-small'
REASONING_MODEL = 'gpt-5.6-sol'
LIMIT_MICRODOLLARS = 5_000_000
RESERVATION = 10_000  # $0.01; never released, including unknown/failed requests.
PRICE_PER_MILLION = 0.02  # Default model; reviewed 2026-09-09; see README.


class Rejected(Exception):
    pass


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, route TEXT, digest TEXT, reserved INTEGER, started REAL, status INTEGER, duration_ms INTEGER, usage TEXT)')
            db.execute("CREATE TABLE IF NOT EXISTS policy(id INTEGER PRIMARY KEY CHECK(id=1),monthly_since REAL)")
            db.execute('INSERT OR IGNORE INTO policy(id,monthly_since) VALUES(1,NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS embedding_route(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT,model TEXT,dimensions INTEGER)')
            if 'audit' not in [r[1] for r in db.execute('PRAGMA table_info(calls)')]: db.execute('ALTER TABLE calls ADD COLUMN audit TEXT')

    def enable_monthly(self):
        # An explicit post-pilot cutover, persisted once; restart cannot reset it.
        with self.connect() as db:
            db.execute('UPDATE policy SET monthly_since=coalesce(monthly_since,?) WHERE id=1',(time.time(),))

    def window(self, db):
        since=db.execute('SELECT monthly_since FROM policy WHERE id=1').fetchone()[0]
        if since is None: return 0, 'pilot'
        month=datetime.now(timezone.utc).replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp()
        return max(since,month), 'monthly'

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db: yield db
        finally: db.close()

    def reserve(self, route, body, embedding=None):
        embedding=embedding or embeddings({})
        amount = embedding.reservation if route == '/v1/embeddings' else 0
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if amount:
                selected=(embedding.provider,embedding.model,embedding.dimensions)
                previous=db.execute('SELECT provider,model,dimensions FROM embedding_route WHERE id=1').fetchone()
                # Old ledgers used the fixed small model. Do not mix those vectors.
                if previous is None and db.execute("SELECT 1 FROM calls WHERE route='/v1/embeddings' LIMIT 1").fetchone():previous=('openai',MODEL,1536)
                if previous is not None and previous!=selected:raise Rejected('embedding_model_change_requires_rebuild')
                db.execute('INSERT OR IGNORE INTO embedding_route VALUES(1,?,?,?)',selected)
            start,mode=self.window(db)
            total, count = db.execute('SELECT coalesce(sum(reserved),0),count(*) FROM calls WHERE started>=?',(start,)).fetchone()
            if total + amount > LIMIT_MICRODOLLARS or count >= 1500:
                raise Rejected('experiment_budget_exhausted' if mode=='pilot' else 'monthly_budget_exhausted')
            audit={'owner_wording':b'Database credentials are in my password manager.' in body,
                   'synthetic_raw_canary':b'mango123' in body}
            return db.execute('INSERT INTO calls(route,digest,reserved,started,audit) VALUES(?,?,?,?,?)',
                (route, hashlib.sha256(body).hexdigest(), amount, time.time(),json.dumps(audit))).lastrowid

    def finish(self, call, status, duration, usage):
        with self.connect() as db:
            db.execute('UPDATE calls SET status=?,duration_ms=?,usage=? WHERE id=?',
                (status, round(duration*1000), json.dumps(usage), call))

    def report(self):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            calls = [dict(row) for row in db.execute('SELECT * FROM calls ORDER BY id')]
            start,mode=self.window(db)
            selected=db.execute('SELECT provider,model,dimensions FROM embedding_route WHERE id=1').fetchone()
        return {'limit_usd': 5, 'mode':mode,'reserved_usd': sum(c['reserved'] for c in calls if c['started']>=start)/1e6,
                'lifetime_reserved_usd':sum(c['reserved'] for c in calls)/1e6,
                'embedding_route':dict(selected) if selected else None,
                'pricing_usd_per_million_embedding_tokens': embeddings({'NOCHEH_EMBEDDING_MODEL':selected['model']}).price_per_million if selected else PRICE_PER_MILLION,
                'note': 'Reservations are conservative, not a provider invoice; unfinished calls remain reserved.', 'calls': calls}


def validate(route, payload, embedding=None):
    embedding=embedding or embeddings({})
    if not isinstance(payload, dict):
        raise Rejected('object_required')
    if route == '/v1/embeddings':
        if set(payload) - {'model', 'input', 'dimensions', 'encoding_format'}:
            raise Rejected('embedding_fields_denied')
        if payload.get('model') != embedding.model or payload.get('dimensions',1536) != embedding.dimensions:
            raise Rejected('embedding_model_denied')
        value = payload.get('input')
        def size(item):
            if isinstance(item,str): return len(item.encode('utf-8'))
            if isinstance(item,list) and item and all(type(n) is int and 0 <= n < 300000 for n in item): return len(item)
            raise Rejected('embedding_input_denied')
        if isinstance(value,str) or (isinstance(value,list) and value and type(value[0]) is int): bound=size(value)
        elif isinstance(value,list) and 0 < len(value) <= 100: bound=sum(size(v) for v in value)
        else: raise Rejected('embedding_input_denied')
        # UTF-8 bytes bound token count. At reviewed model prices this costs at
        # most $0.002622 (small) or $0.017040 (large), below its reservation.
        if not 0 < bound <= 131072: raise Rejected('embedding_bound_exceeded')
        if payload.get('encoding_format','float') not in ('float','base64'): raise Rejected('encoding_denied')
        payload={**payload,'dimensions':embedding.dimensions}
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
    def __init__(self, ledger, token, paid_key, opener=None, prepare=None, embedding=None,
                 reasoning_key=None, reasoning_url='http://shared-provider:8317/v1'):
        self.ledger,self.token,self.paid_key = ledger,token,paid_key
        if reasoning_url.rstrip('/') != 'http://shared-provider:8317/v1':
            raise Rejected('reasoning_route_denied')
        self.reasoning_key=reasoning_key
        if not self.reasoning_key: raise Rejected('reasoning_key_missing')
        self.reasoning_url=reasoning_url.rstrip('/')
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self.prepare=prepare
        self.embedding=embedding or embeddings({})

    def send(self, route, payload, workspace=None):
        payload=validate(route,payload,self.embedding)
        if self.prepare:
            if not isinstance(workspace,str) or not workspace: raise Rejected('memory_context_required')
            payload=validate(route,self.prepare(workspace,route,payload),self.embedding)
        paid=route=='/v1/embeddings'
        if paid and not self.paid_key: raise Rejected('temporary_embedding_key_missing')
        data=json.dumps(payload,ensure_ascii=False).encode()
        if len(data)>1024*1024: raise Rejected('request_too_large')
        call=self.ledger.reserve(route,data,self.embedding)  # fsync transaction BEFORE any egress
        start=time.monotonic();status=502;usage=None
        url=self.embedding.url if paid else (self.reasoning_url+route.removeprefix('/v1'))
        try:
            request=urllib.request.Request(url,data=data,headers={'Authorization':'Bearer '+(self.paid_key if paid else self.reasoning_key),'Content-Type':'application/json'})
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
                status,kind,body=egress.send(self.path,json.loads(self.rfile.read(length)),self.headers.get('X-Nocheh-Workspace'))
            except (Rejected,ValueError) as error:
                status,kind,body=403,'application/json',json.dumps({'error':{'message':str(error) if isinstance(error,Rejected) else 'invalid_json'}}).encode()
            self.respond(status,kind,body)
    return Handler


class ArchivePreparation:
    def __init__(self,url,token):
        self.url=url.rstrip('/')+'/internal/honcho/prepare';self.token=token
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def __call__(self,workspace,route,payload):
        request=urllib.request.Request(self.url,data=json.dumps({'workspace':workspace,'route':route,'payload':payload}).encode(),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:
            with self.opener.open(request,timeout=180) as response:
                content=response.read(2*1024*1024+1)
                if len(content)>2*1024*1024: raise ValueError()
                return json.loads(content)['payload']
        except Exception: raise Rejected('memory_preparation_unavailable') from None


if __name__=='__main__':
    token=Path('/state/internal_token').read_text().strip()
    paid=Path('/run/secrets/temporary_embedding_key').read_text().strip()
    reasoning=Path('/run/secrets/cliproxy_honcho_key').read_text().strip()
    if not token: raise SystemExit('internal_token_missing')
    archive=os.environ.get('NOCHEH_ARCHIVE_URL')
    prepare=ArchivePreparation(archive,token) if archive else None
    ThreadingHTTPServer(('0.0.0.0',8790),handler(Egress(Ledger('/ledger/budget.sqlite'),token,paid,prepare=prepare,
        embedding=embeddings(os.environ),reasoning_key=reasoning,reasoning_url=os.environ.get('NOCHEH_REASONING_URL','http://shared-provider:8317/v1')))).serve_forever()
