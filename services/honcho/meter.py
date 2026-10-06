"""Production Honcho egress: subscription reasoning and strictly budgeted embeddings."""
import hashlib
import hmac
import json
import math
import os
import sqlite3
import time
import uuid
import urllib.error
import urllib.request
from decimal import Decimal, ROUND_CEILING
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import datetime, timezone
from contextlib import contextmanager
try:
    from tools.operations.provider.embedding_config import embeddings
except ModuleNotFoundError:
    from embedding_config import embeddings

MODEL = 'text-embedding-3-small'
REASONING_MODEL = 'gpt-5.6-sol'
PILOT_LIMIT_MICRODOLLARS = 5_000_000
MAX_MONTHLY_LIMIT_CENTS = 1_500
REQUEST_LIMIT = 1_500  # Subscription reasoning attempts per budget window.


class Rejected(Exception):
    pass


class CoolingDown(Rejected):
    def __init__(self, seconds):
        self.seconds = seconds
        super().__init__('embedding_route_cooling_down')


class Ledger:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, route TEXT, digest TEXT, reserved INTEGER, started REAL, status INTEGER, duration_ms INTEGER, usage TEXT)')
            db.execute("CREATE TABLE IF NOT EXISTS policy(id INTEGER PRIMARY KEY CHECK(id=1),monthly_since REAL)")
            db.execute('INSERT OR IGNORE INTO policy(id,monthly_since) VALUES(1,NULL)')
            policy_columns={row[1] for row in db.execute('PRAGMA table_info(policy)')}
            if 'monthly_limit' not in policy_columns: db.execute('ALTER TABLE policy ADD COLUMN monthly_limit INTEGER NOT NULL DEFAULT 5000000')
            if 'revision' not in policy_columns: db.execute('ALTER TABLE policy ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
            if 'last_operation_id' not in policy_columns: db.execute('ALTER TABLE policy ADD COLUMN last_operation_id TEXT')
            db.execute('CREATE TABLE IF NOT EXISTS embedding_route(id INTEGER PRIMARY KEY CHECK(id=1),provider TEXT,model TEXT,dimensions INTEGER)')
            db.execute('CREATE TABLE IF NOT EXISTS egress_cooldown(route TEXT PRIMARY KEY, until REAL NOT NULL, streak INTEGER NOT NULL, failed_at REAL NOT NULL)')
            if 'audit' not in [r[1] for r in db.execute('PRAGMA table_info(calls)')]: db.execute('ALTER TABLE calls ADD COLUMN audit TEXT')
            if 'settlement_version' not in [r[1] for r in db.execute('PRAGMA table_info(calls)')]:
                db.execute('ALTER TABLE calls ADD COLUMN settlement_version INTEGER NOT NULL DEFAULT 0')
            if 'outcome' not in [r[1] for r in db.execute('PRAGMA table_info(calls)')]:
                db.execute('ALTER TABLE calls ADD COLUMN outcome TEXT')
            # Old 502 rows did not distinguish an HTTP response from a lost
            # response. Preserve that uncertainty in the audit, but do not
            # mistake their admission holds for confirmed provider spending.
            db.execute("UPDATE calls SET outcome='legacy_error_unverified' WHERE outcome IS NULL AND status>=400")
            # Preserve the exhausted pilot's historical accounting. Reconcile
            # confirmed monthly calls once, without changing failed or unknown
            # reservations; a restart cannot repeatedly lower a reservation.
            monthly_since=db.execute('SELECT monthly_since FROM policy WHERE id=1').fetchone()[0]
            if monthly_since is not None:
                for (call,) in db.execute("SELECT id FROM calls WHERE route='/v1/embeddings' AND started>=? AND settlement_version=0 AND status IS NOT NULL",(monthly_since,)).fetchall():
                    self._settle_call(db,call)

    @staticmethod
    def _reported_tokens(usage):
        try: value=json.loads(usage) if isinstance(usage,str) else usage
        except (ValueError,TypeError): return None
        count=value.get('total_tokens',value.get('prompt_tokens')) if isinstance(value,dict) else None
        return count if type(count) is int and count>=0 else None

    def _settle_call(self,db,call):
        row=db.execute('SELECT route,reserved,status,usage FROM calls WHERE id=?',(call,)).fetchone()
        if row is None: return
        route,reserved,status,usage=row
        if route!='/v1/embeddings' or not isinstance(status,int): return
        tokens=self._reported_tokens(usage)
        if 200 <= status < 300 and tokens is not None:
            selected=db.execute('SELECT model FROM embedding_route WHERE id=1').fetchone()
            model=selected[0] if selected else MODEL
            price=embeddings({'NOCHEH_EMBEDDING_MODEL':model}).price_per_million
            settled=max(1,int((Decimal(tokens)*Decimal(str(price))).to_integral_value(rounding=ROUND_CEILING)))
            db.execute('UPDATE calls SET reserved=min(reserved,?),settlement_version=1 WHERE id=?',(settled,call))
        else:
            db.execute('UPDATE calls SET settlement_version=1 WHERE id=?',(call,))

    def enable_monthly(self):
        # An explicit post-pilot cutover, persisted once; restart cannot reset it.
        with self.connect() as db:
            db.execute('UPDATE policy SET monthly_since=coalesce(monthly_since,?) WHERE id=1',(time.time(),))

    def window(self, db):
        since=db.execute('SELECT monthly_since FROM policy WHERE id=1').fetchone()[0]
        if since is None: return 0, 'pilot'
        month=datetime.now(timezone.utc).replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp()
        return max(since,month), 'monthly'

    def set_monthly_limit(self, limit_cents, expected_revision, operation_id):
        if type(limit_cents) is not int or not 0 <= limit_cents <= MAX_MONTHLY_LIMIT_CENTS:
            raise Rejected('invalid_budget_limit')
        if type(expected_revision) is not int or expected_revision < 0:
            raise Rejected('invalid_budget_revision')
        try:
            if type(operation_id) is not str or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, AttributeError):
            raise Rejected('invalid_budget_operation') from None
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            since, current, revision, previous=db.execute(
                'SELECT monthly_since,monthly_limit,revision,last_operation_id FROM policy WHERE id=1').fetchone()
            if since is None: raise Rejected('monthly_budget_not_enabled')
            proposed=limit_cents*10_000
            if previous==operation_id:
                if current!=proposed: raise Rejected('budget_operation_conflict')
                return revision
            if revision!=expected_revision: raise Rejected('budget_version_conflict')
            db.execute('UPDATE policy SET monthly_limit=?,revision=revision+1,last_operation_id=? WHERE id=1',
                       (proposed,operation_id))
            return revision+1

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
                cooldown=db.execute('SELECT until FROM egress_cooldown WHERE route=?',(route,)).fetchone()
                if cooldown and cooldown[0]>time.time():
                    raise CoolingDown(math.ceil(cooldown[0]-time.time()))
            if amount:
                selected=(embedding.provider,embedding.model,embedding.dimensions)
                previous=db.execute('SELECT provider,model,dimensions FROM embedding_route WHERE id=1').fetchone()
                # Old ledgers used the fixed small model. Do not mix those vectors.
                if previous is None and db.execute("SELECT 1 FROM calls WHERE route='/v1/embeddings' LIMIT 1").fetchone():previous=('openai',MODEL,1536)
                if previous is not None and previous!=selected:raise Rejected('embedding_model_change_requires_rebuild')
                db.execute('INSERT OR IGNORE INTO embedding_route VALUES(1,?,?,?)',selected)
            start,mode=self.window(db)
            limit=PILOT_LIMIT_MICRODOLLARS if mode=='pilot' else db.execute('SELECT monthly_limit FROM policy WHERE id=1').fetchone()[0]
            total = db.execute("SELECT coalesce(sum(CASE WHEN outcome IN ('http_error','legacy_error_unverified') THEN 0 ELSE reserved END),0) FROM calls WHERE route='/v1/embeddings' AND started>=?",(start,)).fetchone()[0]
            reasoning = db.execute("SELECT count(*) FROM calls WHERE route='/v1/chat/completions' AND started>=?",(start,)).fetchone()[0]
            if amount and total + amount > limit:
                raise Rejected('pilot_budget_exhausted' if mode=='pilot' else 'monthly_budget_exhausted')
            if route=='/v1/chat/completions' and reasoning >= REQUEST_LIMIT:
                raise Rejected('subscription_request_limit_exhausted')
            audit={'owner_wording':b'Database credentials are in my password manager.' in body,
                   'synthetic_raw_canary':b'mango123' in body}
            return db.execute('INSERT INTO calls(route,digest,reserved,started,audit) VALUES(?,?,?,?,?)',
                (route, hashlib.sha256(body).hexdigest(), amount, time.time(),json.dumps(audit))).lastrowid

    def finish(self, call, status, duration, usage, outcome=None):
        with self.connect() as db:
            row=db.execute('SELECT route,started FROM calls WHERE id=?',(call,)).fetchone()
            if outcome not in (None,'response','http_error','transport_error'):
                raise ValueError('invalid_egress_outcome')
            if outcome is None:
                outcome='legacy_error_unverified' if status>=400 else 'response'
            db.execute('UPDATE calls SET status=?,duration_ms=?,usage=?,outcome=? WHERE id=?',
                (status, round(duration*1000), json.dumps(usage), outcome, call))
            self._settle_call(db,call)
            if row and row[0]=='/v1/embeddings':
                previous=db.execute('SELECT until,streak,failed_at FROM egress_cooldown WHERE route=?',(row[0],)).fetchone()
                if 500<=status<600:
                    now=time.time();streak=(previous[1] if previous else 0)+1
                    until=max(previous[0] if previous else 0,now+min(3600,60*2**min(streak-1,6)))
                    db.execute('INSERT INTO egress_cooldown(route,until,streak,failed_at) VALUES(?,?,?,?) '
                               'ON CONFLICT(route) DO UPDATE SET until=excluded.until,streak=excluded.streak,failed_at=excluded.failed_at',
                               (row[0],until,streak,now))
                elif 200<=status<300 and previous and row[1]>previous[2]:
                    db.execute('DELETE FROM egress_cooldown WHERE route=?',(row[0],))

    def report(self):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            calls = [dict(row) for row in db.execute('SELECT * FROM calls ORDER BY id')]
            start,mode=self.window(db)
            monthly_limit,revision=db.execute('SELECT monthly_limit,revision FROM policy WHERE id=1').fetchone()
            selected=db.execute('SELECT provider,model,dimensions FROM embedding_route WHERE id=1').fetchone()
        limit=PILOT_LIMIT_MICRODOLLARS if mode=='pilot' else monthly_limit
        active=[c for c in calls if c['started']>=start and c['route']=='/v1/embeddings']
        released=sum(c['reserved'] for c in active if c['outcome'] in ('http_error','legacy_error_unverified'))
        reserved=sum(c['reserved'] for c in active)-released
        legacy=sum(c['reserved'] for c in active if c['outcome']=='legacy_error_unverified')
        embedding=embeddings({'NOCHEH_EMBEDDING_MODEL':selected['model']}) if selected else embeddings({})
        return {'limit_usd':limit/1e6,'limit_cents':limit//10_000,'max_limit_cents':MAX_MONTHLY_LIMIT_CENTS,
                'revision':revision,'window_started_at':datetime.fromtimestamp(start,timezone.utc).isoformat(),
                'mode':mode,'reserved_usd':reserved/1e6,'remaining_usd':max(0,limit-reserved)/1e6,
                'counted_toward_cap_usd':reserved/1e6,
                'lifetime_reserved_usd':sum(c['reserved'] for c in calls)/1e6,
                'released_error_holds_usd':released/1e6,
                'legacy_error_exposure_unverified_usd':legacy/1e6,
                'embedding_route':dict(selected) if selected else None,
                'embedding_hold_usd':embedding.reservation/1e6,
                'pricing_usd_per_million_embedding_tokens':embedding.price_per_million,
                'note': 'Reported successes settle by tokens. Explicit HTTP errors do not count toward the cap; transport failures, unfinished and unreported calls retain their hold. Legacy error type and provider billing remain unverified; this is not an invoice.', 'calls': calls}

    def summary(self):
        report=self.report();start=datetime.fromisoformat(report['window_started_at']).timestamp()
        current=[call for call in report['calls'] if call['started']>=start]
        embeddings=[call for call in current if call['route']=='/v1/embeddings']
        reasoning=sum(call['route']=='/v1/chat/completions' for call in current)
        tokens=reported=0
        for call in embeddings:
            if not isinstance(call['status'],int) or not 200 <= call['status'] < 300: continue
            count=self._reported_tokens(call['usage'])
            if count is not None:tokens+=count;reported+=1
        return {key:value for key,value in report.items() if key!='calls'} | {
            'embedding_requests':len(embeddings),'reasoning_requests':reasoning,
            'total_requests':len(current),'reasoning_request_limit':REQUEST_LIMIT,
            'reasoning_remaining_requests':max(0,REQUEST_LIMIT-reasoning),
            'embedding_reported_requests':reported,'embedding_unreported_requests':len(embeddings)-reported,
            'embedding_tokens':tokens,
            'estimated_embedding_cost_usd':round(tokens*report['pricing_usd_per_million_embedding_tokens']/1_000_000,8)}


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
        start=time.monotonic();status=502;usage=None;outcome='transport_error'
        url=self.embedding.url if paid else (self.reasoning_url+route.removeprefix('/v1'))
        try:
            request=urllib.request.Request(url,data=data,headers={'Authorization':'Bearer '+(self.paid_key if paid else self.reasoning_key),'Content-Type':'application/json'})
            with self.opener.open(request,timeout=180) as response:
                status=response.status;content=response.read(16*1024*1024+1)
                if len(content)>16*1024*1024: raise Rejected('response_too_large')
                kind=response.headers.get('Content-Type','application/json')
            outcome='response' if 200<=status<300 else 'http_error'
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
            status=error.code;outcome='http_error'
            error.close()
            return status,'application/json',json.dumps({'error':{'message':'honcho_upstream_rejected','code':status}}).encode()
        except Exception:
            status=502
            return 502,'application/json',b'{"error":{"message":"honcho_upstream_unavailable"}}'
        finally:
            self.ledger.finish(call,status,time.monotonic()-start,usage,outcome)


def handler(egress):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self,status,kind,body,retry_after=None):
            self.send_response(status);self.send_header('Content-Type',kind)
            if retry_after is not None:self.send_header('Retry-After',str(retry_after))
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
            except CoolingDown as error:
                return self.respond(503,'application/json',b'{"error":{"message":"embedding_route_cooling_down"}}',error.seconds)
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
