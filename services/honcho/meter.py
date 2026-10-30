"""Production Honcho egress: the memory part's reasoning provider and strictly budgeted embeddings."""
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
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
try:
    from tools.operations.provider.embedding_config import embeddings
except ModuleNotFoundError:
    from embedding_config import embeddings

MODEL = 'text-embedding-3-small'
REASONING_MODEL = os.environ.get('NOCHEH_REASONING_MODEL') or os.environ.get('NOCHEH_MODEL', 'claude-sonnet-5-5')
PILOT_LIMIT_MICRODOLLARS = 5_000_000
MAX_MONTHLY_LIMIT_CENTS = 1_500
SUGGESTED_REASONING_LIMIT = 1_500  # Offered when the owner turns the monthly thinking limit on.
MAX_REASONING_LIMIT = 1_000_000


class Rejected(Exception):
    pass


class CoolingDown(Rejected):
    def __init__(self, seconds):
        self.seconds = seconds
        super().__init__('embedding_route_cooling_down')


class PreparationUnavailable(Rejected):
    """The archive could not prepare this request now; the same request can succeed later."""
    seconds=15
    def __init__(self):
        super().__init__('memory_preparation_unavailable')


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
            # No limit until the owner turns one on.
            if 'reasoning_limit' not in policy_columns: db.execute('ALTER TABLE policy ADD COLUMN reasoning_limit INTEGER')
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
            monthly_since=db.execute('SELECT monthly_since FROM policy WHERE id=1').fetchone()[0]
            if monthly_since is not None:
                db.execute("UPDATE calls SET outcome='legacy_error_unverified' WHERE outcome IS NULL AND status>=400 AND started>=?",(monthly_since,))
            db.execute("UPDATE calls SET outcome='legacy_pilot_error' WHERE outcome IS NULL AND status>=400")
            # Preserve the exhausted pilot's historical accounting. Reconcile
            # confirmed monthly calls once, without changing failed or unknown
            # reservations; a restart cannot repeatedly lower a reservation.
            if monthly_since is not None:
                for (call,) in db.execute("SELECT id FROM calls WHERE route='/v1/embeddings' AND started>=? AND settlement_version=0 AND status IS NOT NULL",(monthly_since,)).fetchall():
                    self._settle_call(db,call)
            db.execute('CREATE TABLE IF NOT EXISTS call_rollups(month TEXT NOT NULL, route TEXT NOT NULL, outcome TEXT NOT NULL, '
                       'calls INTEGER NOT NULL, reserved INTEGER NOT NULL, duration_ms INTEGER NOT NULL, PRIMARY KEY(month,route,outcome))')
            db.execute('CREATE INDEX IF NOT EXISTS calls_started ON calls(started)')
            # Nocheh's usage tracker: daily totals per route, provider and model, never content.
            db.execute('CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL, route TEXT NOT NULL, provider TEXT NOT NULL, '
                       'model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, '
                       'input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, '
                       'cost_microdollars INTEGER NOT NULL DEFAULT 0, priced_calls INTEGER NOT NULL DEFAULT 0, '
                       'PRIMARY KEY(day,route,provider,model))')
        self._rolled=None
        self.roll_up()

    def roll_up(self, now=None):
        """Fold finished calls of closed months into per-month totals.

        Calls of the current cap window and of the previous calendar month stay
        as rows. Older rows become one total per month, route and outcome, so
        lifetime holds, released holds and unverified legacy errors stay
        visible and counted while the table stays bounded. The pilot window
        counts every call, so nothing is folded before monthly mode.
        """
        current=datetime.fromtimestamp(now or time.time(),timezone.utc).replace(day=1,hour=0,minute=0,second=0,microsecond=0)
        if self._rolled==current:return 0
        previous=(current-timedelta(days=1)).replace(day=1)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            start,mode=self.window(db)
            if mode=='pilot':return 0
            before=min(start,previous.timestamp())
            rows=db.execute("SELECT strftime('%Y-%m',started,'unixepoch'),route,coalesce(outcome,CASE WHEN status IS NULL THEN 'unfinished' ELSE 'response' END),"
                            "count(*),coalesce(sum(reserved),0),coalesce(sum(duration_ms),0) FROM calls WHERE started<? GROUP BY 1,2,3",(before,)).fetchall()
            for month,route,outcome,calls,reserved,duration in rows:
                db.execute('INSERT INTO call_rollups(month,route,outcome,calls,reserved,duration_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(month,route,outcome) '
                           'DO UPDATE SET calls=calls+excluded.calls,reserved=reserved+excluded.reserved,duration_ms=duration_ms+excluded.duration_ms',
                           (month,route or '',outcome,calls,reserved,duration))
            folded=db.execute('DELETE FROM calls WHERE started<?',(before,)).rowcount
        self._rolled=current
        return folded

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

    def switch_embedding(self, embedding):
        """After a confirmed memory rebuild Honcho embeds with another model; spending records stay."""
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO embedding_route VALUES(1,?,?,?)',(embedding.provider,embedding.model,embedding.dimensions))

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

    def set_reasoning_limit(self, limit, expected_revision, operation_id):
        """Turn the monthly thinking limit on with a request count, or off with None."""
        if limit is not None and (type(limit) is not int or not 1 <= limit <= MAX_REASONING_LIMIT):
            raise Rejected('invalid_reasoning_limit')
        if type(expected_revision) is not int or expected_revision < 0:
            raise Rejected('invalid_budget_revision')
        try:
            if type(operation_id) is not str or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, AttributeError):
            raise Rejected('invalid_budget_operation') from None
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current, revision, previous=db.execute(
                'SELECT reasoning_limit,revision,last_operation_id FROM policy WHERE id=1').fetchone()
            if previous==operation_id:
                if current!=limit: raise Rejected('budget_operation_conflict')
                return revision
            if revision!=expected_revision: raise Rejected('budget_version_conflict')
            db.execute('UPDATE policy SET reasoning_limit=?,revision=revision+1,last_operation_id=? WHERE id=1',
                       (limit,operation_id))
            return revision+1

    @staticmethod
    def month_start(now=None):
        return datetime.fromtimestamp(now or time.time(),timezone.utc).replace(
            day=1,hour=0,minute=0,second=0,microsecond=0).timestamp()

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
            if amount and total + amount > limit:
                raise Rejected('pilot_budget_exhausted' if mode=='pilot' else 'monthly_budget_exhausted')
            reasoning_limit=db.execute('SELECT reasoning_limit FROM policy WHERE id=1').fetchone()[0]
            if route=='/v1/chat/completions' and reasoning_limit is not None:
                # A request the provider refused outright, such as a dead key, used none of the limit.
                reasoning=db.execute("SELECT count(*) FROM calls WHERE route='/v1/chat/completions' AND started>=? "
                                     "AND outcome IS NOT 'http_error'",(self.month_start(),)).fetchone()[0]
                if reasoning >= reasoning_limit: raise Rejected('reasoning_request_limit_reached')
            audit={'owner_wording':b'Database credentials are in my password manager.' in body,
                   'synthetic_raw_canary':b'mango123' in body}
            return db.execute('INSERT INTO calls(route,digest,reserved,started,audit) VALUES(?,?,?,?,?)',
                (route, hashlib.sha256(body).hexdigest(), amount, time.time(),json.dumps(audit))).lastrowid

    def _count_usage(self,db,route,status,usage,provider,model,now=None):
        moment=datetime.fromtimestamp(now or time.time(),timezone.utc)
        value=usage if isinstance(usage,dict) else {}
        def count(name):
            number=value.get(name)
            return number if type(number) is int and 0<=number<10**12 else 0
        inputs=count('prompt_tokens') or count('input_tokens') or (count('total_tokens') if route=='/v1/embeddings' else 0)
        outputs=count('completion_tokens') or count('output_tokens')
        ok=isinstance(status,int) and 200<=status<300
        cost=None
        if route=='/v1/embeddings' and ok and self._reported_tokens(usage) is not None:
            price=embeddings({'NOCHEH_EMBEDDING_MODEL':model}).price_per_million if model else 0
            cost=int((Decimal(self._reported_tokens(usage))*Decimal(str(price))).to_integral_value(rounding=ROUND_CEILING))
        key=(moment.strftime('%Y-%m-%d'),route,(provider or 'unknown')[:40],(model or 'unknown')[:120])
        db.execute('INSERT INTO usage_daily(day,route,provider,model) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',key)
        db.execute('UPDATE usage_daily SET calls=calls+1,failed=failed+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,'
                   'cost_microdollars=cost_microdollars+?,priced_calls=priced_calls+? WHERE day=? AND route=? AND provider=? AND model=?',
                   (int(not ok),inputs,outputs,cost or 0,int(cost is not None),*key))
        db.execute('DELETE FROM usage_daily WHERE day<?',((moment-timedelta(days=400)).strftime('%Y-%m-%d'),))

    def usage(self, since_day):
        with self.connect() as db:
            db.row_factory=sqlite3.Row
            return [dict(row) for row in db.execute('SELECT * FROM usage_daily WHERE day>=? ORDER BY day,route,provider,model',(since_day,))]

    def finish(self, call, status, duration, usage, outcome=None, provider='', model=''):
        self.roll_up()
        with self.connect() as db:
            row=db.execute('SELECT route,started FROM calls WHERE id=?',(call,)).fetchone()
            if outcome not in (None,'response','http_error','transport_error'):
                raise ValueError('invalid_egress_outcome')
            if outcome is None:
                outcome='legacy_error_unverified' if status>=400 else 'response'
            db.execute('UPDATE calls SET status=?,duration_ms=?,usage=?,outcome=? WHERE id=?',
                (status, round(duration*1000), json.dumps(usage), outcome, call))
            self._settle_call(db,call)
            if row:self._count_usage(db,row[0],status,usage,provider,model)
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
            rollups = [dict(row) for row in db.execute('SELECT * FROM call_rollups ORDER BY month,route,outcome')]
            start,mode=self.window(db)
            monthly_limit,revision,reasoning_limit=db.execute('SELECT monthly_limit,revision,reasoning_limit FROM policy WHERE id=1').fetchone()
            selected=db.execute('SELECT provider,model,dimensions FROM embedding_route WHERE id=1').fetchone()
        limit=PILOT_LIMIT_MICRODOLLARS if mode=='pilot' else monthly_limit
        active=[c for c in calls if c['started']>=start and c['route']=='/v1/embeddings']
        released=sum(c['reserved'] for c in active if c['outcome'] in ('http_error','legacy_error_unverified'))
        reserved=sum(c['reserved'] for c in active)-released
        legacy=sum(c['reserved'] for c in active if c['outcome']=='legacy_error_unverified')
        embedding=embeddings({'NOCHEH_EMBEDDING_MODEL':selected['model']}) if selected else embeddings({})
        return {'limit_usd':limit/1e6,'limit_cents':limit//10_000,'max_limit_cents':MAX_MONTHLY_LIMIT_CENTS,
                'revision':revision,'window_started_at':datetime.fromtimestamp(start,timezone.utc).isoformat(),
                'mode':mode,'reasoning_request_limit':reasoning_limit,'reserved_usd':reserved/1e6,'remaining_usd':max(0,limit-reserved)/1e6,
                'counted_toward_cap_usd':reserved/1e6,
                'lifetime_reserved_usd':(sum(c['reserved'] for c in calls)+sum(r['reserved'] for r in rollups))/1e6,
                'released_error_holds_usd':released/1e6,
                'legacy_error_exposure_unverified_usd':legacy/1e6,
                'embedding_route':dict(selected) if selected else None,
                'embedding_hold_usd':embedding.reservation/1e6,
                'pricing_usd_per_million_embedding_tokens':embedding.price_per_million,
                'note': 'Reported successes settle by tokens. Explicit HTTP errors do not count toward the cap; transport failures, unfinished and unreported calls retain their hold. Legacy error type and provider billing remain unverified; this is not an invoice.', 'calls': calls, 'monthly_rollups': rollups}

    def summary(self):
        report=self.report();start=datetime.fromisoformat(report['window_started_at']).timestamp()
        current=[call for call in report['calls'] if call['started']>=start]
        embeddings=[call for call in current if call['route']=='/v1/embeddings']
        month=self.month_start()
        reasoning=sum(call['route']=='/v1/chat/completions' and call['outcome']!='http_error' and call['started']>=month
                      for call in report['calls'])
        limit=report['reasoning_request_limit']
        tokens=reported=0
        for call in embeddings:
            if not isinstance(call['status'],int) or not 200 <= call['status'] < 300: continue
            count=self._reported_tokens(call['usage'])
            if count is not None:tokens+=count;reported+=1
        return {key:value for key,value in report.items() if key!='calls'} | {
            'embedding_requests':len(embeddings),'reasoning_requests':reasoning,
            'total_requests':len(current),'suggested_reasoning_limit':SUGGESTED_REASONING_LIMIT,
            'max_reasoning_limit':MAX_REASONING_LIMIT,
            'reasoning_remaining_requests':None if limit is None else max(0,limit-reasoning),
            'embedding_reported_requests':reported,'embedding_unreported_requests':len(embeddings)-reported,
            'embedding_tokens':tokens,
            'estimated_embedding_cost_usd':round(tokens*report['pricing_usd_per_million_embedding_tokens']/1_000_000,8)}


OUTPUT_BOUND = 8192


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
        # Covers Honcho's own output caps (long session summaries ask for 6000).
        for field in ('max_tokens','max_completion_tokens'):
            if field in payload and (type(payload[field]) is not int or not 0 < payload[field] <= OUTPUT_BOUND): raise Rejected('output_bound_exceeded')
        if not any(k in payload for k in ('max_tokens','max_completion_tokens')): payload['max_completion_tokens']=OUTPUT_BOUND
    else: raise Rejected('route_denied')
    return payload


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class Egress:
    def __init__(self, ledger, token, paid_key, opener=None, prepare=None, embedding=None,
                 reasoning_key=None, reasoning_url=None, providers=None):
        self.ledger,self.token,self.paid_key = ledger,token,paid_key
        # Settings provider ids by route, for the usage tracker's rows.
        self.providers=providers or {}
        # The HTTPS provider the owner chose for memory in Settings › Models. Without
        # one the meter still starts: embeddings work and reasoning is refused.
        reasoning_url=(reasoning_url or '').strip().rstrip('/')
        if reasoning_url and not reasoning_url.startswith('https://'):
            raise Rejected('reasoning_route_denied')
        self.reasoning_key=(reasoning_key or '').strip()
        if reasoning_url and not self.reasoning_key: raise Rejected('reasoning_key_missing')
        self.reasoning_url=reasoning_url
        self.opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self.prepare=prepare
        self.embedding=embedding or embeddings({})

    def send(self, route, payload, workspace=None, background=False):
        payload=validate(route,payload,self.embedding)
        if self.prepare:
            if not isinstance(workspace,str) or not workspace: raise Rejected('memory_context_required')
            payload=validate(route,self.prepare(workspace,route,payload,background),self.embedding)
        paid=route=='/v1/embeddings'
        if not paid and not self.reasoning_url: raise Rejected('provider_not_configured')
        if paid and not self.paid_key: raise Rejected('temporary_embedding_key_missing')
        data=json.dumps(payload,ensure_ascii=False).encode()
        if len(data)>1024*1024: raise Rejected('request_too_large')
        call=self.ledger.reserve(route,data,self.embedding)  # fsync transaction BEFORE any egress
        start=time.monotonic();status=502;usage=None;outcome='transport_error'
        url=self.embedding.url if paid else (self.reasoning_url+route.removeprefix('/v1'))
        try:
            request=urllib.request.Request(url,data=data,headers={'Authorization':'Bearer '+(self.paid_key if paid else self.reasoning_key),'Content-Type':'application/json',
                # Providers behind browser checks reject Python's default client name.
                'User-Agent':'Nocheh'})
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
            self.ledger.finish(call,status,time.monotonic()-start,usage,outcome,provider=self.providers.get(route,''),
                               model=self.embedding.model if paid else REASONING_MODEL)


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
                status,kind,body=egress.send(self.path,json.loads(self.rfile.read(length)),self.headers.get('X-Nocheh-Workspace'),
                                             self.headers.get('X-Nocheh-Priority')=='background')
            except (CoolingDown,PreparationUnavailable) as error:
                return self.respond(503,'application/json',json.dumps({'error':{'message':str(error)}}).encode(),error.seconds)
            except (Rejected,ValueError) as error:
                status,kind,body=403,'application/json',json.dumps({'error':{'message':str(error) if isinstance(error,Rejected) else 'invalid_json'}}).encode()
            self.respond(status,kind,body)
    return Handler


# Archive refusals that describe a race with a concurrent change, not the request.
RETRYABLE_PREPARATION=frozenset({'audience_context_changed','runtime_context_conflict'})


class ArchivePreparation:
    def __init__(self,url,token):
        self.url=url.rstrip('/')+'/internal/honcho/prepare';self.token=token
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def __call__(self,workspace,route,payload,background=False):
        body={'workspace':workspace,'route':route,'payload':payload,**({'background':True} if background else {})}
        request=urllib.request.Request(self.url,data=json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:
            with self.opener.open(request,timeout=180) as response:
                content=response.read(2*1024*1024+1)
        except urllib.error.HTTPError as error:
            code=error.code
            try: reason=json.loads(error.read(4096)).get('error')
            except Exception: reason=None
            finally: error.close()
            # Only the archive's own refusals are final, such as a hidden message or a
            # request it may not prepare. Honcho drops a batch it is refused, but retries
            # an outage, and the guard epoch moving on mid-request is retried the same way.
            if code>=500 or isinstance(reason,str) and reason in RETRYABLE_PREPARATION: raise PreparationUnavailable() from None
            raise Rejected('memory_preparation_refused') from None
        except Exception: raise PreparationUnavailable() from None
        try:
            if len(content)>2*1024*1024: raise ValueError()
            return json.loads(content)['payload']
        except Exception: raise Rejected('memory_preparation_refused') from None


if __name__=='__main__':
    token=Path('/state/internal_token').read_text().strip()
    paid=Path('/run/secrets/temporary_embedding_key').read_text().strip()
    # The memory part's provider and key arrive in meter.env; both are empty until
    # a provider is chosen in Settings › Models.
    reasoning=os.environ.get('NOCHEH_REASONING_KEY','').strip()
    if not token: raise SystemExit('internal_token_missing')
    archive=os.environ.get('NOCHEH_ARCHIVE_URL')
    prepare=ArchivePreparation(archive,token) if archive else None
    ThreadingHTTPServer(('0.0.0.0',8790),handler(Egress(Ledger('/ledger/budget.sqlite'),token,paid,prepare=prepare,
        embedding=embeddings(os.environ),reasoning_key=reasoning,reasoning_url=os.environ.get('NOCHEH_REASONING_URL',''),
        providers={'/v1/embeddings':os.environ.get('NOCHEH_EMBEDDING_PROVIDER','openai'),
                   '/v1/chat/completions':os.environ.get('NOCHEH_REASONING_PROVIDER','')}))).serve_forever()
