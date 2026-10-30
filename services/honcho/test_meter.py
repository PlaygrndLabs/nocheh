import concurrent.futures
import io
import json
import sqlite3
import tempfile
import unittest
import urllib.error
import uuid
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from .meter import REASONING_MODEL, ArchivePreparation, CoolingDown, Egress, Ledger, PreparationUnavailable, Rejected, handler, validate


GATEWAY='https://gateway.example.test/v1'


class Response(io.BytesIO):
    status=200
    headers={'Content-Type':'application/json'}


class Transport:
    def __init__(self, fail=False): self.calls=[];self.fail=fail
    def open(self,request,timeout):
        self.calls.append(request)
        if self.fail: raise TimeoutError()
        return Response(b'{"data":[],"usage":{"prompt_tokens":10,"total_tokens":10}}')


class HttpFailureTransport:
    def open(self,request,timeout):
        raise urllib.error.HTTPError(request.full_url,502,'upstream failure',{},io.BytesIO())


class BudgetTests(unittest.TestCase):
    def test_closed_months_fold_into_totals_without_changing_lifetime_or_the_cap(self):
        from datetime import datetime, timezone
        at=lambda month,day=10:datetime(2026,month,day,tzinfo=timezone.utc).timestamp()
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';Ledger(path)
            with sqlite3.connect(path) as db:
                rows=[('/v1/embeddings',10_000,at(7),200,'response'),('/v1/embeddings',10_000,at(7,20),502,'http_error'),
                      ('/v1/embeddings',10_000,at(8),502,'legacy_error_unverified'),('/v1/chat/completions',0,at(8),200,'response'),
                      ('/v1/embeddings',20,at(9),200,'response'),('/v1/embeddings',30,at(10),200,'response')]
                db.executemany('INSERT INTO calls(route,reserved,started,status,outcome,duration_ms,settlement_version) VALUES(?,?,?,?,?,5,1)',rows)
                db.execute('UPDATE policy SET monthly_since=? WHERE id=1',(at(7,1),))
            with patch('services.honcho.meter.time.time',return_value=at(10,15)):
                self.assertEqual(Ledger(path).roll_up(at(10,15)),0,'the ledger opened in October already folded')
                before=Ledger(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM calls').fetchone()[0],2,'September and October keep their rows')
                rolled=db.execute('SELECT month,route,outcome,calls,reserved FROM call_rollups ORDER BY 1,2,3').fetchall()
            self.assertEqual(rolled,[('2026-07','/v1/embeddings','http_error',1,10_000),('2026-07','/v1/embeddings','response',1,10_000),
                                     ('2026-08','/v1/chat/completions','response',1,0),('2026-08','/v1/embeddings','legacy_error_unverified',1,10_000)])
            report=before.report()
            self.assertEqual(report['lifetime_reserved_usd'],(30_000+20+30)/1e6)
            self.assertEqual(len(report['monthly_rollups']),4)
            self.assertEqual(before.roll_up(at(10,28)),0,'a second fold in the same month does nothing')
            self.assertEqual(before.roll_up(at(11,2)),1,'a new month folds September')

    def test_the_pilot_window_keeps_every_call(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path)
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO calls(route,reserved,started,status,outcome) VALUES('/v1/embeddings',10000,?,200,'response')",
                           (datetime(2025,1,5,tzinfo=timezone.utc).timestamp(),))
            self.assertEqual(Ledger(path).roll_up(),0)
            self.assertEqual(Ledger(path).report()['reserved_usd'],.01)

    def test_monthly_limit_changes_are_durable_revision_checked_and_do_not_reset_reservations(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path);ledger.enable_monthly()
            ledger.reserve('/v1/embeddings',b'first')
            operation=str(uuid.uuid4())
            self.assertEqual(ledger.set_monthly_limit(2,0,operation),1)
            self.assertEqual(ledger.set_monthly_limit(2,0,operation),1)
            self.assertEqual(ledger.report()['reserved_usd'],.01)
            self.assertEqual(ledger.report()['limit_usd'],.02)
            with self.assertRaisesRegex(Rejected,'budget_version_conflict'):
                ledger.set_monthly_limit(3,0,str(uuid.uuid4()))
            ledger.reserve('/v1/embeddings',b'second')
            with self.assertRaisesRegex(Rejected,'monthly_budget_exhausted'):
                ledger.reserve('/v1/embeddings',b'third')
            self.assertEqual(ledger.set_monthly_limit(0,1,str(uuid.uuid4())),2)
            # The paid route stops, but subscription reasoning remains available.
            ledger.reserve('/v1/chat/completions',b'reasoning')
            with self.assertRaisesRegex(Rejected,'monthly_budget_exhausted'):
                ledger.reserve('/v1/embeddings',b'paused')
            restored=Ledger(path).report()
            self.assertEqual((restored['limit_usd'],restored['reserved_usd'],restored['revision']),(0,.02,2))

    def test_limit_validation_and_old_policy_migration(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE policy(id INTEGER PRIMARY KEY CHECK(id=1),monthly_since REAL)')
                db.execute('INSERT INTO policy VALUES(1,NULL)')
            ledger=Ledger(path)
            self.assertEqual(ledger.report()['limit_cents'],500)
            with self.assertRaisesRegex(Rejected,'monthly_budget_not_enabled'):
                ledger.set_monthly_limit(100,0,str(uuid.uuid4()))
            ledger.enable_monthly()
            for amount in (True,-1,1_501,1.5):
                with self.assertRaisesRegex(Rejected,'invalid_budget_limit'):
                    ledger.set_monthly_limit(amount,0,str(uuid.uuid4()))
            with self.assertRaisesRegex(Rejected,'invalid_budget_operation'):
                ledger.set_monthly_limit(100,0,'not-a-uuid')

    def test_summary_distinguishes_reserved_from_reported_embedding_usage(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');ledger.enable_monthly()
            good=ledger.reserve('/v1/embeddings',b'good');ledger.finish(good,200,0.1,{'total_tokens':9280})
            failed=ledger.reserve('/v1/embeddings',b'failed');ledger.finish(failed,502,0.1,None)
            reasoning=ledger.reserve('/v1/chat/completions',b'reasoning');ledger.finish(reasoning,200,0.1,{'total_tokens':40})
            summary=ledger.summary()
            self.assertNotIn('calls',summary)
            self.assertEqual((summary['embedding_requests'],summary['reasoning_requests']),(2,1))
            self.assertEqual((summary['embedding_reported_requests'],summary['embedding_unreported_requests']),(1,1))
            self.assertEqual(summary['reserved_usd'],.000186)
            self.assertEqual(summary['counted_toward_cap_usd'],.000186)
            self.assertEqual(summary['legacy_error_exposure_unverified_usd'],.01)
            self.assertEqual(summary['estimated_embedding_cost_usd'],.0001856)

    def test_monthly_legacy_successes_settle_once_but_uncertain_and_pilot_calls_keep_their_holds(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path)
            pilot=ledger.reserve('/v1/embeddings',b'pilot')
            pilot_error=ledger.reserve('/v1/embeddings',b'pilot-error')
            ledger.enable_monthly()
            good=ledger.reserve('/v1/embeddings',b'good')
            failed=ledger.reserve('/v1/embeddings',b'failed')
            unknown=ledger.reserve('/v1/embeddings',b'unknown')
            with sqlite3.connect(path) as db:
                db.execute('UPDATE calls SET status=200,usage=?,settlement_version=0 WHERE id=?',(json.dumps({'total_tokens':9280}),good))
                db.execute('UPDATE calls SET status=502,settlement_version=0 WHERE id=?',(failed,))
                db.execute('UPDATE calls SET status=200,usage=NULL,settlement_version=0 WHERE id=?',(unknown,))
                db.execute('UPDATE calls SET status=200,usage=?,settlement_version=0 WHERE id=?',(json.dumps({'total_tokens':10}),pilot))
                db.execute('UPDATE calls SET status=502,settlement_version=0 WHERE id=?',(pilot_error,))
            first=Ledger(path).report()
            second=Ledger(path).report()
            self.assertEqual(first['reserved_usd'],.010186)
            self.assertEqual(second['reserved_usd'],first['reserved_usd'])
            self.assertEqual(first['lifetime_reserved_usd'],.040186)
            self.assertEqual(first['legacy_error_exposure_unverified_usd'],.01)
            self.assertEqual(first['calls'][pilot_error-1]['outcome'],'legacy_pilot_error')

    def test_http_error_releases_cap_but_transport_failure_keeps_hold(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path);ledger.enable_monthly()
            payload={'model':'text-embedding-3-small','input':'fixture'}
            status=Egress(ledger,'internal','temporary',HttpFailureTransport(),reasoning_key='honcho-client').send('/v1/embeddings',payload)[0]
            self.assertEqual(status,502)
            report=Ledger(path).report()
            self.assertEqual(report['reserved_usd'],0)
            self.assertEqual(report['released_error_holds_usd'],.01)
            self.assertEqual(report['calls'][0]['outcome'],'http_error')
            with sqlite3.connect(path) as db:db.execute('DELETE FROM egress_cooldown')
            status=Egress(ledger,'internal','temporary',Transport(True),reasoning_key='honcho-client').send('/v1/embeddings',payload)[0]
            self.assertEqual(status,502)
            self.assertEqual(Ledger(path).report()['reserved_usd'],.01)

    def test_embedding_cap_and_thinking_limit_are_independent(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');ledger.enable_monthly()
            revision=ledger.set_monthly_limit(1,0,str(uuid.uuid4()))
            ledger.set_reasoning_limit(2,revision,str(uuid.uuid4()))
            for index in range(2):ledger.reserve('/v1/chat/completions',f'reasoning-{index}'.encode())
            with self.assertRaisesRegex(Rejected,'reasoning_request_limit_reached'):
                ledger.reserve('/v1/chat/completions',b'third')
            ledger.reserve('/v1/embeddings',b'paid')
            with self.assertRaisesRegex(Rejected,'monthly_budget_exhausted'):
                ledger.reserve('/v1/embeddings',b'second-paid')
            self.assertEqual(ledger.summary()['reasoning_remaining_requests'],0)

    def test_thinking_is_unlimited_until_the_owner_turns_a_limit_on(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite')
            for index in range(5):ledger.reserve('/v1/chat/completions',f'free-{index}'.encode())
            summary=ledger.summary()
            self.assertIsNone(summary['reasoning_request_limit'])
            self.assertIsNone(summary['reasoning_remaining_requests'])
            self.assertEqual(summary['reasoning_requests'],5)
            revision=ledger.set_reasoning_limit(5,0,str(uuid.uuid4()))
            with self.assertRaisesRegex(Rejected,'reasoning_request_limit_reached'):
                ledger.reserve('/v1/chat/completions',b'over')
            ledger.set_reasoning_limit(None,revision,str(uuid.uuid4()))
            ledger.reserve('/v1/chat/completions',b'free-again')
            for value in (0,-1,1.5,'10',True):
                with self.assertRaisesRegex(Rejected,'invalid_reasoning_limit'):
                    ledger.set_reasoning_limit(value,2,str(uuid.uuid4()))

    def test_thinking_limit_counts_this_month_only(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path)
            ledger.reserve('/v1/chat/completions',b'last-month')
            with ledger.connect() as db:
                db.execute('UPDATE calls SET started=?',(Ledger.month_start()-60,))
            ledger.set_reasoning_limit(1,0,str(uuid.uuid4()))
            ledger.reserve('/v1/chat/completions',b'this-month')
            with self.assertRaisesRegex(Rejected,'reasoning_request_limit_reached'):
                ledger.reserve('/v1/chat/completions',b'over')

    def test_refused_reasoning_requests_do_not_use_the_limit(self):
        # A dead provider key answers every retry with 401; those must not use up the limit.
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');ledger.set_reasoning_limit(2,0,str(uuid.uuid4()))
            for index in range(3):
                call=ledger.reserve('/v1/chat/completions',f'refused-{index}'.encode())
                ledger.finish(call,401,.1,None,'http_error')
            call=ledger.reserve('/v1/chat/completions',b'dropped')
            ledger.finish(call,502,.1,None,'transport_error')
            self.assertEqual(ledger.summary()['reasoning_remaining_requests'],1)
            ledger.reserve('/v1/chat/completions',b'answered')
            with self.assertRaisesRegex(Rejected,'reasoning_request_limit_reached'):
                ledger.reserve('/v1/chat/completions',b'over')

    def test_a_refused_request_logs_the_providers_reason_only(self):
        class Refusing:
            def open(self,request,timeout):
                body={'type':'error','error':{'type':'invalid_request_error','message':'synthetic: field not supported'}}
                raise urllib.error.HTTPError(request.full_url,400,'',{},io.BytesIO(json.dumps(body).encode()))
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite')
            egress=Egress(ledger,'internal','temporary',Refusing(),reasoning_key='honcho-client',reasoning_url=GATEWAY)
            payload={'model':REASONING_MODEL,'messages':[{'role':'user','content':'private words'}]}
            with patch('sys.stderr',new=io.StringIO()) as log:
                status,_,body=egress.send('/v1/chat/completions',payload)
            line=json.loads(log.getvalue())
            self.assertEqual((status,line['status'],line['type'],line['message']),
                             (400,400,'invalid_request_error','synthetic: field not supported'))
            self.assertNotIn('private words',log.getvalue())
            self.assertEqual(json.loads(body)['error']['message'],'honcho_upstream_rejected')

    def test_monthly_cutover_is_durable_and_does_not_erase_pilot(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path)
            for _ in range(500): ledger.reserve('/v1/embeddings',b'pilot')
            ledger.enable_monthly();ledger.reserve('/v1/embeddings',b'monthly')
            ledger=Ledger(path);ledger.enable_monthly()
            self.assertEqual(ledger.report()['mode'],'monthly')
            self.assertEqual(ledger.report()['reserved_usd'],.01)
            self.assertEqual(ledger.report()['lifetime_reserved_usd'],5.01)
            for _ in range(499): ledger.reserve('/v1/embeddings',b'monthly')
            with self.assertRaisesRegex(Rejected,'monthly_budget_exhausted'): ledger.reserve('/v1/embeddings',b'exhausted')

    def test_embedding_egress_uses_prepared_wording_and_rejects_retired_context(self):
        with tempfile.TemporaryDirectory() as root:
            transport=Transport();ledger=Ledger(Path(root)/'budget.sqlite')
            def prepare(workspace,route,payload,background=False):
                if workspace!='current': raise Rejected('memory_context_retired')
                return {**payload,'input':'Database credentials are in my password manager.'}
            egress=Egress(ledger,'internal','dedicated',transport,prepare,reasoning_key='honcho-client')
            payload={'model':'text-embedding-3-small','input':'Database password: planted-secret'}
            egress.send('/v1/embeddings',payload,'current')
            self.assertNotIn(b'planted-secret',transport.calls[0].data)
            self.assertIn(b'password manager',transport.calls[0].data)
            audit=json.loads(ledger.report()['calls'][0]['audit'])
            self.assertEqual(audit,{'owner_wording':True,'synthetic_raw_canary':False})
            seen=[]
            Egress(ledger,'internal','dedicated',transport,lambda workspace,route,body,background:seen.append(background) or body,
                   reasoning_key='honcho-client').send('/v1/embeddings',{'model':'text-embedding-3-small','input':'fixture'},'current',True)
            self.assertEqual(seen,[True])
            with self.assertRaises(Rejected): egress.send('/v1/embeddings',payload,'retired')
            with self.assertRaises(Rejected): egress.send('/v1/embeddings',payload)
            self.assertEqual(len(transport.calls),2)

    def test_archive_preparation_forwards_background_priority(self):
        sent=[]
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self,*args): pass
        preparation=ArchivePreparation('http://archive','internal')
        preparation.opener=SimpleNamespace(open=lambda request,timeout:sent.append(json.loads(request.data)) or Response(b'{"payload":{}}'))
        preparation('current','/v1/embeddings',{'input':'fixture'})
        preparation('current','/v1/embeddings',{'input':'fixture'},True)
        self.assertNotIn('background',sent[0]);self.assertIs(sent[1]['background'],True)

    def test_archive_preparation_outage_is_retryable_and_refusal_is_final(self):
        def failing(error):
            preparation=ArchivePreparation('http://archive','internal')
            def open_(request,timeout): raise error
            preparation.opener=SimpleNamespace(open=open_)
            return preparation
        def http(code,reason):
            return urllib.error.HTTPError('http://archive',code,'',{},io.BytesIO(json.dumps({'error':reason}).encode()))
        for error in [TimeoutError(),urllib.error.URLError('refused'),http(503,'service_unavailable'),http(503,'detector_contract_rejected'),
                      http(409,'audience_context_changed'),http(409,'runtime_context_conflict')]:
            with self.assertRaises(PreparationUnavailable): failing(error)('current','/v1/embeddings',{'input':'fixture'})
        for error in [http(403,'bound_guard_context_required'),http(409,'memory_context_retired'),http(422,'guard_candidate_rejected')]:
            with self.assertRaises(Rejected) as refused: failing(error)('current','/v1/embeddings',{'input':'fixture'})
            self.assertNotIsInstance(refused.exception,PreparationUnavailable)
            self.assertEqual(str(refused.exception),'memory_preparation_refused')

    def test_preparation_outage_answers_503_and_refusal_answers_403_without_spending(self):
        def unavailable(workspace,route,payload,background): raise PreparationUnavailable()
        def refused(workspace,route,payload,background): raise Rejected('memory_preparation_refused')
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport()
            def post(prepare):
                endpoint=handler(Egress(ledger,'internal','temporary',transport,prepare,reasoning_key='honcho-client',reasoning_url=GATEWAY))
                body=json.dumps({'model':REASONING_MODEL,'messages':[{'role':'user','content':'fixture'}]}).encode()
                request=object.__new__(endpoint);request.path='/v1/chat/completions'
                request.headers={'Authorization':'Bearer internal','Content-Length':str(len(body)),'X-Nocheh-Workspace':'current'}
                request.rfile=io.BytesIO(body);request.wfile=io.BytesIO()
                result={'headers':{}}
                request.send_response=lambda status:result.update(status=status)
                request.send_header=lambda key,value:result['headers'].update({key:value})
                request.end_headers=lambda:None
                request.do_POST()
                return result['status'],result['headers'].get('Retry-After'),json.loads(request.wfile.getvalue())['error']['message']
            self.assertEqual(post(unavailable),(503,'15','memory_preparation_unavailable'))
            self.assertEqual(post(refused),(403,None,'memory_preparation_refused'))
            self.assertEqual(transport.calls,[]);self.assertEqual(ledger.report()['reserved_usd'],0)

    def test_concurrent_budget_restart_and_zero_egress(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport()
            # Reserve 499 calls, then race the final dollar-cent across threads.
            for _ in range(499): ledger.reserve('/v1/embeddings',b'fixture')
            egress=Egress(ledger,'internal','temporary',transport,reasoning_key='honcho-client')
            def send(_):
                try: return egress.send('/v1/embeddings',{'model':'text-embedding-3-small','input':'fixture'})[0]
                except Rejected: return 'blocked'
            with concurrent.futures.ThreadPoolExecutor(8) as pool: results=list(pool.map(send,range(16)))
            self.assertEqual(results.count(200),1);self.assertEqual(len(transport.calls),1)
            restored=Ledger(Path(root)/'budget.sqlite')
            self.assertEqual(restored.report()['reserved_usd'],4.990001)
            with self.assertRaises(Rejected): restored.reserve('/v1/embeddings',b'new')

    def test_timeout_reservation_and_missing_key(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport(True)
            payload={'model':'text-embedding-3-small','input':['hello']}
            with self.assertRaises(Rejected): Egress(ledger,'internal','',transport,reasoning_key='honcho-client').send('/v1/embeddings',payload)
            self.assertEqual(ledger.report()['reserved_usd'],0);self.assertEqual(len(transport.calls),0)
            self.assertEqual(Egress(ledger,'internal','temporary',transport,reasoning_key='honcho-client').send('/v1/embeddings',payload)[0],502)
            self.assertEqual(ledger.report()['reserved_usd'],.01)

    def test_embedding_transport_cooldown_preserves_holds_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'budget.sqlite';ledger=Ledger(path);transport=Transport(True)
            payload={'model':'text-embedding-3-small','input':'fixture'}
            with patch('services.honcho.meter.time.time',return_value=1_800_000_000):
                egress=Egress(ledger,'internal','temporary',transport,reasoning_key='honcho-client',reasoning_url=GATEWAY)
                self.assertEqual(egress.send('/v1/embeddings',payload)[0],502)
                with self.assertRaises(CoolingDown) as first:
                    egress.send('/v1/embeddings',payload)
                self.assertEqual(first.exception.seconds,60)
                def cooled(_):
                    try: egress.send('/v1/embeddings',payload)
                    except CoolingDown: return True
                    return False
                with concurrent.futures.ThreadPoolExecutor(8) as pool:
                    self.assertEqual(list(pool.map(cooled,range(16))),[True]*16)
                self.assertEqual(len(transport.calls),1)
                self.assertEqual(ledger.report()['reserved_usd'],.01)
                # A different route remains available while embeddings cool down.
                self.assertEqual(egress.send('/v1/chat/completions',{'model':REASONING_MODEL,'messages':[]})[0],502)
            restored=Ledger(path)
            with patch('services.honcho.meter.time.time',return_value=1_800_000_061):
                egress=Egress(restored,'internal','temporary',transport,reasoning_key='honcho-client')
                self.assertEqual(egress.send('/v1/embeddings',payload)[0],502)
                with self.assertRaises(CoolingDown) as second:
                    egress.send('/v1/embeddings',payload)
                self.assertEqual(second.exception.seconds,120)
                self.assertEqual(restored.report()['reserved_usd'],.02)
            transport.fail=False
            with patch('services.honcho.meter.time.time',return_value=1_800_000_182):
                self.assertEqual(egress.send('/v1/embeddings',payload)[0],200)
                self.assertEqual(egress.send('/v1/embeddings',payload)[0],200)
                self.assertEqual(restored.report()['reserved_usd'],.020002)

    def test_late_embedding_success_cannot_clear_new_transport_cooldown(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite')
            with patch('services.honcho.meter.time.time',return_value=1_800_000_000):
                older=ledger.reserve('/v1/embeddings',b'older')
            with patch('services.honcho.meter.time.time',return_value=1_800_000_001):
                failed=ledger.reserve('/v1/embeddings',b'failed')
                ledger.finish(failed,502,.1,None)
            with patch('services.honcho.meter.time.time',return_value=1_800_000_002):
                ledger.finish(older,200,.1,{'total_tokens':10})
                with self.assertRaises(CoolingDown):ledger.reserve('/v1/embeddings',b'blocked')
            self.assertEqual(ledger.summary()['embedding_requests'],2)

    def test_embedding_http_cooldown_returns_retry_after_without_new_reservation(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport(True)
            endpoint=handler(Egress(ledger,'internal','temporary',transport,reasoning_key='honcho-client'))
            def post():
                body=json.dumps({'model':'text-embedding-3-small','input':'fixture'}).encode()
                request=object.__new__(endpoint);request.path='/v1/embeddings'
                request.headers={'Authorization':'Bearer internal','Content-Length':str(len(body))}
                request.rfile=io.BytesIO(body);request.wfile=io.BytesIO()
                result={'headers':{}}
                request.send_response=lambda status:result.update(status=status)
                request.send_header=lambda key,value:result['headers'].update({key:value})
                request.end_headers=lambda:None
                request.do_POST()
                return result['status'],result['headers'].get('Retry-After')
            with patch('services.honcho.meter.time.time',return_value=1_800_000_000):
                self.assertEqual(post(),(502,None))
                self.assertEqual(post(),(503,'60'))
                self.assertEqual(len(transport.calls),1)
                self.assertEqual(ledger.report()['reserved_usd'],.01)

    def test_route_model_bounds(self):
        for route,payload in [('/v1/responses',{}),('/v1/embeddings',{'model':'expensive','input':'x'}),('/v1/embeddings',{'model':'text-embedding-3-small','input':'x'*131073}),('/v1/chat/completions',{'model':'other','messages':[]})]:
            with self.assertRaises(Rejected): validate(route,payload)
        # Honcho's long session summary asks for 6000 output tokens; it must pass, larger asks must not.
        summary={'model':REASONING_MODEL,'messages':[],'max_tokens':6000}
        self.assertEqual(validate('/v1/chat/completions',dict(summary))['max_tokens'],6000)
        with self.assertRaises(Rejected): validate('/v1/chat/completions',{**summary,'max_tokens':8193})

    def test_json_object_format_is_dropped_and_other_formats_pass(self):
        # The deriver's json_object mode carries its schema in the prompt; Claude refuses the format type.
        deriver={'model':REASONING_MODEL,'messages':[],'max_tokens':100,'response_format':{'type':'json_object'}}
        self.assertNotIn('response_format',validate('/v1/chat/completions',dict(deriver)))
        schema={'type':'json_schema','json_schema':{'name':'x','schema':{'type':'object'}}}
        self.assertEqual(validate('/v1/chat/completions',{**deriver,'response_format':schema})['response_format'],schema)

    def test_memory_provider_from_settings_must_use_https(self):
        with tempfile.TemporaryDirectory() as root:
            transport=Transport();ledger=Ledger(Path(root)/'budget.sqlite')
            Egress(ledger,'internal','temporary',transport,reasoning_key='synthetic-provider-key',
                   reasoning_url=GATEWAY+'/').send('/v1/chat/completions',{'model':REASONING_MODEL,'messages':[]})
            self.assertEqual(transport.calls[0].full_url,GATEWAY+'/chat/completions')
            self.assertEqual(transport.calls[0].get_header('Authorization'),'Bearer synthetic-provider-key')
            self.assertEqual(transport.calls[0].get_header('User-agent'),'Nocheh')
            self.assertEqual(ledger.report()['reserved_usd'],0)
            for url,key in (('http://gateway.example.test/v1','k'),('http://shared-provider:8317/v1','k'),
                            ('file:///etc/passwd','k'),(GATEWAY,'')):
                with self.subTest(url=url),self.assertRaises(Rejected):
                    Egress(ledger,'internal','temporary',transport,reasoning_key=key,reasoning_url=url)

    def test_meter_starts_without_a_reasoning_provider_and_still_embeds(self):
        with tempfile.TemporaryDirectory() as root:
            transport=Transport();ledger=Ledger(Path(root)/'budget.sqlite')
            egress=Egress(ledger,'internal','temporary',transport,reasoning_key='',reasoning_url='')
            self.assertEqual(egress.send('/v1/embeddings',{'model':'text-embedding-3-small','input':'fixture'})[0],200)
            with self.assertRaisesRegex(Rejected,'provider_not_configured'):
                egress.send('/v1/chat/completions',{'model':REASONING_MODEL,'messages':[]})
            # The refusal reaches no provider and holds no budget.
            self.assertEqual(len(transport.calls),1)
            self.assertEqual(ledger.summary()['reasoning_requests'],0)
            self.assertEqual(Egress(ledger,'internal','temporary',transport).reasoning_url,'')

    def test_usage_tracker_counts_each_call_by_provider_and_model_without_content(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport()
            egress=Egress(ledger,'internal','temporary',transport,reasoning_key='honcho-client',reasoning_url=GATEWAY,
                          providers={'/v1/embeddings':'openai','/v1/chat/completions':'custom-1'})
            egress.send('/v1/embeddings',{'model':'text-embedding-3-small','input':['private words']})
            egress.send('/v1/chat/completions',{'model':REASONING_MODEL,'messages':[{'role':'user','content':'private words'}]})
            Egress(ledger,'internal','temporary',HttpFailureTransport(),reasoning_key='honcho-client',
                   providers={'/v1/embeddings':'openai'}).send('/v1/embeddings',{'model':'text-embedding-3-small','input':['x']})
            rows={(row['route'],row['provider']):row for row in ledger.usage('2000-01-01')}
            embedding=rows[('/v1/embeddings','openai')]
            self.assertEqual((embedding['calls'],embedding['failed'],embedding['input_tokens']),(2,1,10))
            self.assertEqual(embedding['priced_calls'],1,'only the call that reported tokens is priced')
            self.assertGreater(embedding['cost_microdollars'],0)
            memory=rows[('/v1/chat/completions','custom-1')]
            self.assertEqual((memory['model'],memory['calls'],memory['input_tokens'],memory['priced_calls']),(REASONING_MODEL,1,10,0))
            self.assertNotIn('private words',json.dumps(ledger.usage('2000-01-01')))


if __name__=='__main__': unittest.main()
