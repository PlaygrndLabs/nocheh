import sqlite3
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from . import usage

DAY = datetime(2026, 10, 13, 12, tzinfo=timezone.utc).timestamp()


class UsageTests(unittest.TestCase):
    def test_hermes_turn_usage_keeps_counts_and_never_turns_an_unknown_cost_into_zero(self):
        priced = {'input_tokens': 100, 'output_tokens': 20, 'api_calls': 2, 'estimated_cost_usd': 0.004,
                  'cost_status': 'estimated', 'model': 'synthetic-model', 'final_response': 'private words'}
        unknown = {'input_tokens': 50, 'output_tokens': 5, 'api_calls': 1, 'estimated_cost_usd': None, 'cost_status': 'unknown'}
        included = {'input_tokens': 10, 'api_calls': 1, 'estimated_cost_usd': 0.3, 'cost_status': 'included'}
        self.assertEqual(usage.turn_usage(priced)['cost_usd'], 0.004)
        self.assertNotIn('private words', repr(usage.turn_usage(priced)))
        self.assertNotIn('cost_usd', usage.turn_usage(unknown))
        self.assertEqual(usage.turn_usage(included)['cost_usd'], 0.0, 'a subscription plan costs nothing per call')
        total = usage.combine([priced, unknown])
        self.assertEqual((total['input_tokens'], total['calls'], total['model']), (150, 3, 'synthetic-model'))
        self.assertNotIn('cost_usd', total, 'one unpriced run leaves the total cost unknown')
        self.assertIsNone(usage.combine([]))

    def test_record_adds_runs_to_one_daily_row_and_drops_rows_past_retention(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('guard', {'calls': 1}, 'm', provider='custom-1', path=path, now=DAY - 401 * 86400)
            usage.record('reply', {'input_tokens': 10, 'calls': 1, 'cost_usd': 0.5}, 'm', provider='openai', path=path, now=DAY)
            usage.record('reply', {'input_tokens': 5, 'calls': 2}, 'm', failed=True, provider='openai', path=path, now=DAY)
            usage.record('unknown-part', {'calls': 1}, 'm', provider='openai', path=path, now=DAY)
            rows = usage.rows('2000-01-01', path)
            self.assertEqual(len(rows), 1, 'the old guard row was pruned and an unknown part is not counted')
            row = rows[0]
            self.assertEqual((row['day'], row['part'], row['runs'], row['failed'], row['calls'], row['input_tokens']),
                             ('2026-10-13', 'reply', 2, 1, 3, 15))
            self.assertEqual((row['cost_usd'], row['priced_runs']), (0.5, 1), 'the unpriced run stays visible as unpriced')

    def test_refusals_and_hidden_texts_are_counted_and_an_older_table_gains_their_columns(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            path.parent.mkdir()
            old = sqlite3.connect(str(path))
            old.execute(usage.SCHEMA.replace('refused INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, ', '')
                        .replace("reasons TEXT NOT NULL DEFAULT '{}', ", ''))
            old.execute("INSERT INTO usage_daily(day,part,provider,model,runs,failed) VALUES('2026-10-13','guard','anthropic','m',3,1)")
            old.commit()
            old.close()
            usage.record('guard', {'calls': 1}, 'm', failed=True, refused=True, provider='anthropic', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'm', refused=True, provider='anthropic', path=path, now=DAY)
            usage.note_hidden('guard', 'm', provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['runs'], row['failed'], row['refused'], row['hidden']), (5, 3, 2, 1),
                             'a refusal is always a failure; a hidden text is not a run')
            self.assertEqual(row['reasons'], {'refused': 2}, 'the older table gains the reasons too')

    def test_failed_runs_keep_why_they_failed_as_codes_only(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            for reason in ('timed_out', 'timed_out', 'refused', 'a provider message, not a code'):
                usage.record('memory_review', {'calls': 1}, 'm', failed=True, reason=reason, provider='anthropic', path=path, now=DAY)
            usage.record('memory_review', {'calls': 1}, 'm', reason='timed_out', provider='anthropic', path=path, now=DAY)
            usage.record('memory_review', {'calls': 1}, 'm', failed=True, reason='job_cost_limit', provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['runs'], row['failed'], row['refused']), (6, 4, 1), "a run Nocheh's own limit stopped is no failure")
            self.assertEqual(row['reasons'], {'timed_out': 2, 'refused': 1, 'unknown': 1},
                             'an unknown code is kept as unknown, and a run that worked has no reason')

    def test_why_a_hermes_turn_or_a_direct_call_failed(self):
        cases = [
            ([{'failed': True, 'failure_reason': 'content_policy_blocked', 'error': 'private words'}], 'refused'),
            ([{'completed': True, 'turn_exit_reason': 'text_response(finish_reason=refusal)', 'final_response': ''}], 'refused'),
            ([{'failed': True, 'failure_reason': 'rate_limit'}], 'rate_limited'),
            ([{'failed': True, 'failure_reason': 'server_error'}], 'provider_error'),
            ([{'failed': True, 'failure_reason': 'timeout'}], 'timed_out'),
            ([{'completed': False, 'turn_exit_reason': 'max_iterations_reached(90/90)'}], 'too_long'),
            ([{'completed': False, 'interrupted': True}], 'interrupted'),
            ([{'completed': True, 'final_response': ' '}], 'empty_answer'),
            ([{'completed': True, 'final_response': 'fine'}, {'failed': True}], 'unknown'),
            # The broker's refusal of a job's call past its byte backstop is Nocheh's own stop, not a rejected key.
            ([{'failed': True, 'failure_reason': 'format_error', 'error': 'HTTP 409: {"error":"job_cost_limit"}'}], 'job_cost_limit'),
            ([], 'unknown'),
        ]
        for results, reason in cases:
            self.assertEqual(usage.failure_reason(results), reason, results)
        class Status(Exception):
            def __init__(self, status_code): self.status_code = status_code
        self.assertEqual([usage.error_reason(error) for error in (Status(429), Status(401), Status(503), TimeoutError(), ValueError())],
                         ['rate_limited', 'key_rejected', 'provider_error', 'timed_out', 'unknown'])

    def test_a_failure_keeps_the_providers_exact_error_as_codes_only(self):
        # The exit reason as Hermes builds it (agent/turn_loop_errors.py): the API error's first 80 characters,
        # with the error as the OpenAI client prints it.
        outer = lambda call, status, body: 'repeated_outer_errors(' + f'Error during API call #{call}: Error code: {status} - {body}'[:80] + ')'
        cases = [
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 529: Overloaded'}], ('provider_error', 'overloaded:529')),
            ([{'failed': True, 'failure_reason': 'server_error', 'error': 'HTTP 500 — Internal Server Error'}],
             ('provider_error', 'server_error:500')),
            ([{'failed': True, 'failure_reason': 'timeout', 'error': 'Request timed out.'}], ('timed_out', 'timeout')),
            ([{'failed': True, 'failure_reason': 'thinking_signature', 'error': 'HTTP 400: private words'}],
             ('provider_error', 'thinking_signature:400')),
            # Without Hermes's name for the error, the provider's HTTP status names it and says the reason.
            ([{'failed': True, 'error': 'HTTP 503: busy'}], ('provider_error', 'overloaded:503')),
            ([{'failed': True, 'failure_reason': 'unknown', 'error': 'HTTP 429: slow down'}], ('rate_limited', 'rate_limit:429')),
            ([{'failed': True, 'error': 'HTTP 418: odd'}], ('provider_error', 'http_error:418')),
            ([{'failed': True, 'error': 'private words, HTTP 529 inside'}], ('unknown', None)),
            ([{'failed': True, 'failure_reason': 'Private Words!', 'error': 'private words'}], ('provider_error', None)),
            ([{'failed': True, 'failure_reason': 'format_error', 'error': 'HTTP 409: {"error":"job_cost_limit"}'}], ('job_cost_limit', None)),
            # A sealed turn reaches the provider through Nocheh's broker, which answers with its own status: Hermes's name
            # for that status says nothing of the provider, so only the provider's own status, when the broker gives it, counts.
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 503: {"error":"provider_request_failed","provider_status":529}'}],
             ('provider_error', 'overloaded:529')),
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 503: {"error":"provider_request_failed","provider_status":404}'}],
             ('model_not_found', 'model_not_found:404')),
            ([{'failed': True, 'failure_reason': 'rate_limit', 'error': 'HTTP 429: {"error":"provider_request_failed","provider_status":429}'}],
             ('rate_limited', 'rate_limit:429')),
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 503: {"error":"provider_request_failed"}'}], ('provider_error', None)),
            # The broker's own refusals, such as an unavailable secret check or a changed policy, are Nocheh's errors, named by their code.
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 503: {"error":"required_guard_unavailable"}'}],
             ('nocheh_error', 'required_guard_unavailable')),
            ([{'failed': True, 'failure_reason': 'format_error', 'error': 'HTTP 409: {"error":"security_policy_changed"}'}],
             ('nocheh_error', 'security_policy_changed')),
            # The safety epoch moved on during the run: Nocheh's own stop, which it runs again, not a failure.
            ([{'failed': True, 'failure_reason': 'format_error', 'error': 'HTTP 409: {"error":"runtime_turn_changed"}'}], ('context_changed', None)),
            ([{'failed': True, 'failure_reason': 'format_error', 'error': 'HTTP 409: {"error":"guard_context_changed"}'}], ('context_changed', None)),
            ([{'completed': True, 'turn_exit_reason': 'text_response(finish_reason=refusal)', 'final_response': ''}], ('refused', None)),
            # Hermes stopped the loop itself: not a provider error, unless the error that stopped it says so. Only codes are kept.
            *[([{'failed': True, 'failure_reason': 'loop_error', 'turn_exit_reason': exit_reason, 'error': 'Private words'}], expected)
              for exit_reason, expected in [
                  ('repeated_outer_errors(Error during API call #3: Connection error.)', ('provider_error', 'connection')),
                  ('repeated_outer_errors(Error during API call #2: Request timed out.)', ('timed_out', 'timeout')),
                  (outer(2, 529, "{'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}"),
                   ('provider_error', 'overloaded:529')),
                  # Through the broker: its own refusals are Nocheh's errors, even with the code cut short.
                  (outer(2, 503, "{'error': 'required_guard_unavailable'}"), ('nocheh_error', 'repeated_outer_errors')),
                  (outer(2, 503, "{'error': 'security_service_unavailable'}"), ('nocheh_error', 'repeated_outer_errors')),
                  (outer(2, 403, "{'error': 'model_configuration_mismatch'}"), ('nocheh_error', 'repeated_outer_errors')),
                  # A short code fits whole.
                  (outer(2, 403, "{'error': 'turn_source_denied'}"), ('nocheh_error', 'turn_source_denied')),
                  (outer(2, 409, "{'error': 'runtime_turn_changed'}"), ('context_changed', None)),
                  # A provider's refusal: the broker's status is the provider's own only for 401, 403 and 429.
                  (outer(3, 429, "{'error': 'provider_request_failed', 'provider_status': 429}"), ('rate_limited', 'rate_limit:429')),
                  (outer(3, 401, "{'error': 'provider_request_failed', 'provider_status': 401}"), ('key_rejected', 'auth:401')),
                  (outer(2, 503, "{'error': 'provider_request_failed', 'provider_status': 529}"), ('provider_error', 'repeated_outer_errors')),
                  (outer(1000, 503, "{'error': 'provider_request_failed', 'provider_status': 500}"), ('provider_error', 'repeated_outer_errors')),
                  ("repeated_outer_errors(Error during API call #3: KeyError: 'connection_id' private words)", ('unknown', 'repeated_outer_errors')),
                  ('error_near_max_iterations(Error during API call #9: private words)', ('unknown', 'error_near_max_iterations')),
                  ('pending_tool_result', ('empty_answer', 'pending_tool_result')),
                  ('local_processing_error(Error during local message processing after API call #2: private words)',
                   ('nocheh_error', 'local_processing_error')),
                  ('rebuilt_restart_limit_exceeded', ('interrupted', 'rebuilt_restart_limit_exceeded')),
                  ('a_new_stop(private words)', ('unknown', 'loop_error'))]],
            ([], ('unknown', None)),
        ]
        for results, expected in cases:
            self.assertEqual(usage.failure(results), expected, results)
        class Status(Exception):
            def __init__(self, status_code): self.status_code = status_code
        class APIConnectionError(Exception): pass
        class APITimeoutError(APIConnectionError): pass
        self.assertEqual([usage.error_cause(error) for error in (Status(529), Status(401), Status(418), Status('529'), APITimeoutError(),
                                                                 APIConnectionError(), ConnectionResetError(), ValueError('private words'))],
                         ['overloaded:529', 'auth:401', 'http_error:418', None, 'timeout', 'connection', 'connection', None])

    def test_a_call_nochehs_secret_check_refused_is_named_by_its_code_not_as_a_provider_error(self):
        # The provider client reports a call the secret check refused as a lost connection, and Hermes names it by the
        # status of the secret check's answer, here 409 as a malformed request.
        refused = {'failed': True, 'failure_reason': 'format_error', 'error': 'Connection error.'}
        loop = {'failed': True, 'failure_reason': 'loop_error', 'error': 'private words',
                'turn_exit_reason': 'repeated_outer_errors(Error during API call #3: Connection error.)'}
        cases = [
            ([refused], [], ('provider_error', 'format_error')),
            ([refused], ['guard_context_changed'], ('context_changed', None)),
            ([refused], ['guard_transition_pending'], ('context_changed', None)),
            ([refused], ['required_guard_unavailable', 'detector_contract_rejected'], ('nocheh_error', 'detector_contract_rejected')),
            ([loop], ['service_unavailable'], ('nocheh_error', 'service_unavailable')),
            # Once the epoch moved on, every later call of the run is refused, whatever the run's own error says.
            ([{'failed': True, 'failure_reason': 'timeout', 'error': 'Request timed out.'}], ['guard_context_changed'], ('context_changed', None)),
            # Any other refusal says nothing of a provider's own error.
            ([{'failed': True, 'failure_reason': 'overloaded', 'error': 'HTTP 529: Overloaded'}], ['required_guard_unavailable'],
             ('provider_error', 'overloaded:529')),
            ([refused], ['Private Words!'], ('provider_error', 'format_error')),
            ([{'completed': True, 'final_response': 'fine'}, refused], ['detector_contract_rejected'], ('nocheh_error', 'detector_contract_rejected')),
        ]
        for results, refusals, expected in cases:
            self.assertEqual(usage.failure(results, refusals), expected, (results, refusals))
        # A turn that ended on Nocheh's own error before any model run keeps that error's code.
        self.assertEqual([usage.nocheh_failure(code) for code in ('guard_context_changed', 'assistant_runtime_unavailable', 'Private Words!', None)],
                         [('context_changed', None), ('nocheh_error', 'assistant_runtime_unavailable'), ('nocheh_error', None), ('nocheh_error', None)])
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('reply', {'calls': 1}, 'm', failed=True, reason='context_changed', provider='anthropic', path=path, now=DAY)
            usage.record('reply', {'calls': 1}, 'm', failed=True, reason='nocheh_error', cause='detector_contract_rejected',
                         provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['runs'], row['failed'], row['reasons'], row['causes']),
                             (2, 1, {'nocheh_error': 1}, {'nocheh_error:detector_contract_rejected': 1}),
                             'a run the new epoch stopped counts as a run, not as a failure the owner is told of')

    def test_failed_runs_keep_the_providers_exact_error_and_an_older_table_gains_it(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            path.parent.mkdir()
            old = sqlite3.connect(str(path))
            old.execute(usage.SCHEMA.replace("causes TEXT NOT NULL DEFAULT '{}', ", ''))
            old.commit()
            old.close()
            for cause in ('overloaded:529', 'overloaded:529', 'server_error', 'a provider message, not a code', None):
                usage.record('memory_review', {'calls': 1}, 'm', failed=True, reason='provider_error', cause=cause,
                             provider='anthropic', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'm', failed=True, cause='connection', provider='anthropic', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'm', cause='overloaded:529', provider='anthropic', path=path, now=DAY)
            guard, review = usage.rows('2026-10-13', path)
            self.assertEqual((review['part'], review['failed'], review['reasons']), ('memory_review', 5, {'provider_error': 5}))
            self.assertEqual(review['causes'], {'provider_error:overloaded:529': 2, 'provider_error:server_error': 1},
                             'only codes are kept; a run without a known cause keeps its reason alone')
            self.assertEqual((guard['failed'], guard['causes']), (1, {'unknown:connection': 1}), 'a run that worked has no cause')

    def test_record_never_fails_the_work_it_measures(self):
        with tempfile.TemporaryDirectory() as root:
            # Outside a Hermes installation nothing is written.
            usage.record('reply', {'calls': 1}, 'm', path=Path(root) / 'missing/usage/usage.sqlite', now=DAY)
            self.assertFalse((Path(root) / 'missing').exists())
            # A broken database is skipped quietly.
            broken = Path(root) / 'usage'
            broken.mkdir()
            (broken / 'usage.sqlite').mkdir()
            usage.record('reply', {'calls': 1}, 'm', path=broken / 'usage.sqlite', now=DAY)

    def test_record_takes_the_part_provider_from_the_settings_route(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(
                'os.environ', {'NOCHEH_REPLY_ROUTE_PROVIDER': 'anthropic', 'NOCHEH_GUARD_ROUTE_PROVIDER': 'custom-1'}):
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('schedule', {'calls': 1, 'model': 'turn-model'}, 'fallback', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'guard-model', path=path, now=DAY)
            found = {(row['part'], row['provider'], row['model']) for row in usage.rows('2026-10-13', path)}
            self.assertEqual(found, {('schedule', 'anthropic', 'turn-model'), ('guard', 'custom-1', 'guard-model')})

    def test_parts(self):
        self.assertEqual(usage.part_of({'review': True, 'channel': 'telegram'}), 'memory_review')
        self.assertEqual(usage.part_of({'channel': 'scheduler'}), 'schedule')
        self.assertEqual(usage.part_of({'channel': 'browser'}), 'browser')
        self.assertEqual(usage.part_of({'channel': 'telegram'}), 'reply')

    def test_price_uses_hermes_pricing_and_leaves_unknown_prices_empty(self):
        class Cost:
            def __init__(self, amount, status): self.amount_usd, self.status = amount, status

        def estimate(model, canonical, provider, base_url):
            if model == 'broken':
                raise RuntimeError('no table')
            return {'known': Cost(canonical.input_tokens / 1e6, 'estimated'), 'plan': Cost(None, 'included')}.get(
                model, Cost(None, 'unknown'))

        pricing = types.SimpleNamespace(CanonicalUsage=types.SimpleNamespace, estimate_usage_cost=estimate)
        rows = [{'model': name, 'input_tokens': 2_000_000, 'output_tokens': 1} for name in ('known', 'plan', 'custom', 'broken')]
        with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.usage_pricing': pricing}):
            self.assertEqual(usage.price(rows), [2.0, 0.0, None, None])
            with self.assertRaises(ValueError):
                usage.price([{'model': 3}])

    def test_claude_is_priced_from_anthropic_list_prices(self):
        million = {'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'calls': 10}
        self.assertAlmostEqual(usage.claude_cost('claude-sonnet-5-5', million), 12.0)
        self.assertAlmostEqual(usage.claude_cost('anthropic/claude-opus-5.5', million), 24.0, msg='dotted and prefixed names')
        cached = {'input_tokens': 0, 'cache_read_tokens': 1_000_000, 'cache_write_tokens': 1_000_000, 'calls': 10}
        self.assertAlmostEqual(usage.claude_cost('claude-sonnet-5-5', cached), 0.2 + 2.5)
        self.assertAlmostEqual(usage.claude_cost('claude-haiku-5-5', million), 0.6)
        self.assertAlmostEqual(usage.claude_cost('claude-haiku-5-5', {**million, 'calls': 1}), 3.0, msg='a prompt over 100K tokens')
        self.assertIsNone(usage.claude_cost('synthetic-model', million))

    def test_record_prices_claude_on_the_anthropic_provider_only_when_hermes_did_not(self):
        spent = {'input_tokens': 1_000_000, 'output_tokens': 100_000, 'calls': 4, 'model': 'claude-sonnet-5-5'}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('reply', spent, 'fallback', provider='anthropic', path=path, now=DAY)
            usage.record('guard', {**spent, 'cost_usd': 0.5}, 'm', provider='anthropic', path=path, now=DAY)
            usage.record('memory_review', spent, 'fallback', provider='custom-1', path=path, now=DAY)
            usage.record('schedule', {'calls': 1}, 'claude-sonnet-5-5', provider='anthropic', path=path, now=DAY)
            found = {row['part']: (round(row['cost_usd'], 6), row['priced_runs']) for row in usage.rows('2026-10-13', path)}
        self.assertEqual(found['reply'], (3.0, 1))
        self.assertEqual(found['guard'], (0.5, 1), "Hermes's own price stays")
        self.assertEqual(found['memory_review'], (0.0, 0), 'a gateway may bill differently, so its cost stays unknown')
        self.assertEqual(found['schedule'], (0.0, 0), 'a run without token counts stays unknown')

    def test_price_falls_back_to_claude_prices_on_the_anthropic_provider(self):
        class Cost:
            amount_usd, status = None, 'unknown'

        pricing = types.SimpleNamespace(CanonicalUsage=types.SimpleNamespace, estimate_usage_cost=lambda *a, **k: Cost())
        row = {'model': 'claude-sonnet-5-5', 'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'calls': 2}
        with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.usage_pricing': pricing}):
            costs = usage.price([{**row, 'provider': 'anthropic'}, {**row, 'provider': 'custom'}, row])
        self.assertEqual(costs, [12.0, None, None])

    def test_reply_rates_take_the_higher_claude_card_per_bucket_on_the_anthropic_provider(self):
        with patch.dict('os.environ', {}, clear=False):
            self.assertEqual(usage.reply_rates('claude-sonnet-5-5', 'anthropic', ''),
                             {'input': 2.0, 'output': 10.0, 'cache_read': 0.2, 'cache_write': 2.5, 'request': 0.0})
            self.assertEqual(usage.reply_rates('anthropic/claude-haiku-5.5', 'anthropic', ''),
                             {'input': 0.5, 'output': 2.5, 'cache_read': 0.05, 'cache_write': 0.625, 'request': 0.0}, 'the long-prompt card is higher')

    def test_reply_rates_ask_hermes_with_million_token_rows_and_stay_unknown_without_a_price(self):
        class Cost:
            def __init__(self, amount, status): self.amount_usd, self.status = amount, status

        def estimate(model, canonical, provider, base_url):
            if model != 'priced-model':
                return Cost(None, 'unknown')
            # A whole prompt over 200K tokens is priced at a higher tier, output included.
            above = canonical.input_tokens + canonical.cache_read_tokens + canonical.cache_write_tokens > 200_000
            rates = (3, 15, 0.3, 4) if above else (1, 5, 0.1, 2)
            # A per-request price, as a model list can carry, counts only for a row with calls.
            return Cost(sum(getattr(canonical, bucket) * rate for bucket, rate in zip(usage.CLAUDE_BUCKETS, rates)) / 1e6
                        + canonical.request_count * 0.005, 'estimated')

        pricing = types.SimpleNamespace(CanonicalUsage=types.SimpleNamespace, estimate_usage_cost=estimate)
        with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.usage_pricing': pricing}):
            self.assertEqual(usage.reply_rates('priced-model', 'openai', 'https://gateway.example.test/v1'),
                             {'input': 3.0, 'output': 15.0, 'cache_read': 0.3, 'cache_write': 4.0, 'request': 0.005})
            unknown = dict.fromkeys(usage.RATES)
            self.assertEqual(usage.reply_rates('synthetic-model', 'openai', ''), unknown)
            self.assertEqual(usage.reply_rates('claude-sonnet-5-5', 'custom', ''), unknown, "Nocheh's Claude prices are for Anthropic's own API only")
        with patch.dict(sys.modules, {'agent': None}):
            self.assertEqual(usage.reply_rates('synthetic-model', 'openai', ''), dict.fromkeys(usage.RATES), 'without Hermes nothing is priced')

    def test_the_fixture_rates_count_only_inside_the_installation_fixture(self):
        given = {usage.FIXTURE_RATES: '{"input": 50, "output": 50, "cache_read": 0.5, "cache_write": "x"}'}
        with patch.dict('os.environ', {**given, 'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            self.assertEqual(usage.reply_rates('fixture-model', 'model-fixture', ''),
                             {'input': 50.0, 'output': 50.0, 'cache_read': 0.5, 'cache_write': None, 'request': None})
        with patch.dict('os.environ', {**given, 'NOCHEH_INSTALLATION_FIXTURE': '1', usage.FIXTURE_RATES: 'not json'}):
            self.assertEqual(usage.reply_rates('fixture-model', 'model-fixture', ''), dict.fromkeys(usage.RATES))
        for flag in ('0', '', 'true'):
            with patch.dict('os.environ', {**given, 'NOCHEH_INSTALLATION_FIXTURE': flag}), patch.dict(sys.modules, {'agent': None}):
                self.assertEqual(usage.reply_rates('fixture-model', 'model-fixture', ''), dict.fromkeys(usage.RATES), 'outside the fixture it does nothing')
                self.assertEqual(usage.reply_rates('claude-sonnet-5-5', 'anthropic', '')['input'], 2.0)


if __name__ == '__main__':
    unittest.main()
