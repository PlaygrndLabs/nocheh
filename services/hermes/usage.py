"""Nocheh's own model usage tracker for the parts Hermes runs.

Hermes reports each turn's token buckets, API calls and estimated cost itself;
the secret check reads its provider response's usage and prices it with
Hermes's own pricing table. Nocheh keeps one row per UTC day, part, provider
and model, never content, so the table stays small and bounded.

Nocheh calls every provider through the OpenAI-compatible API, so Hermes's
table, keyed by provider, never prices a Claude model. Nocheh prices Claude
on the Anthropic provider itself, only where Hermes has no price.
"""
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATABASE = Path(os.environ.get('NOCHEH_USAGE_DB', '/workspace/data/local/hermes/usage/usage.sqlite'))
RETENTION_DAYS = 400
PARTS = ('reply', 'browser', 'schedule', 'background', 'memory_review', 'guard', 'transcription', 'image')
TOKENS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens')
PROVIDERS = {'reply': 'NOCHEH_REPLY_ROUTE_PROVIDER', 'guard': 'NOCHEH_GUARD_ROUTE_PROVIDER',
             'transcription': 'NOCHEH_TRANSCRIPTION_ROUTE_PROVIDER', 'image': 'NOCHEH_IMAGE_ROUTE_PROVIDER'}
SCHEMA = ('CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL, part TEXT NOT NULL, provider TEXT NOT NULL, '
          'model TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, '
          'calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, '
          'output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, '
          'cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, '
          'cost_usd REAL NOT NULL DEFAULT 0, priced_runs INTEGER NOT NULL DEFAULT 0, '
          'refused INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, '
          "reasons TEXT NOT NULL DEFAULT '{}', causes TEXT NOT NULL DEFAULT '{}', "
          'PRIMARY KEY(day,part,provider,model))')
# Columns added after the first table: `refused` is a failed run the model declined to answer,
# `hidden` a text the secret check hid whole because the model declined to check it, and
# `reasons` the failed runs counted by why they failed, such as {"refused": 2, "timed_out": 1},
# `causes` the same runs counted by the provider's exact error where it is known, keyed by reason and
# cause, such as {"provider_error:overloaded:529": 1}, and `audio_seconds` the length of the
# recordings voice-note transcription was sent.
ADDED = {'refused': 'INTEGER NOT NULL DEFAULT 0', 'hidden': 'INTEGER NOT NULL DEFAULT 0', 'reasons': "TEXT NOT NULL DEFAULT '{}'",
         'audio_seconds': 'REAL NOT NULL DEFAULT 0', 'causes': "TEXT NOT NULL DEFAULT '{}'"}
# Why a run failed. Codes only: never the provider's message or any content.
REASONS = ('refused', 'rate_limited', 'key_rejected', 'model_not_found', 'too_long', 'timed_out',
           'provider_error', 'interrupted', 'empty_answer', 'bad_answer', 'nocheh_error', 'unknown')
# Runs Nocheh's own policy ended, which are not model failures: a job's model call the broker refused past its
# byte backstop (ADR-0206), known by the broker's exact refusal body in the run's error, and a run whose model call
# Nocheh refused because the safety epoch moved on during the run, such as when the owner saved a memory, which
# Nocheh runs again in the new epoch (ADR-0220).
STOPS = ('job_cost_limit', 'context_changed')
JOB_COST_LIMIT = '{"error":"job_cost_limit"}'
# Nocheh's refusals, by its broker or its secret check, that say the run's safety context moved on.
CONTEXT_CHANGES = ('guard_context_changed', 'guard_transition_pending', 'audience_context_changed', 'runtime_turn_changed')
# Hermes's classified failure reasons, by the code Nocheh keeps.
HERMES_REASONS = {
    'refused': ('content_policy_blocked', 'provider_policy_blocked', 'data_policy_denied'),
    'rate_limited': ('rate_limit', 'upstream_rate_limit', 'billing'),
    'key_rejected': ('auth', 'auth_permanent', 'model_entitlement'),
    'model_not_found': ('model_not_found',),
    'too_long': ('context_overflow', 'payload_too_large', 'truncated', 'image_too_large'),
    'timed_out': ('timeout',),
    'provider_error': ('overloaded', 'server_error', 'upstream_blocked', 'incomplete_response', 'format_error'),
}
# A failed run's cause: Hermes's own name for the provider's error, such as `overloaded`, and the
# provider's HTTP status when it sent one, such as `overloaded:529`. Codes only, never the provider's message.
CODE = re.compile(r'[a-z][a-z0-9_]{0,47}')
CAUSE = re.compile(r'[a-z][a-z0-9_]{0,47}(?::[1-5][0-9]{2})?')
# A key of the `causes` column: the reason, then the cause.
CAUSE_KEY = re.compile(r'[a-z_]{1,24}:[a-z][a-z0-9_]{0,47}(?::[1-5][0-9]{2})?')
# Hermes's names (agent/error_classifier.py) for an HTTP status, for a failure Hermes did not name.
STATUS_CAUSES = {400: 'format_error', 401: 'auth', 402: 'billing', 403: 'auth', 404: 'model_not_found', 408: 'timeout',
                 413: 'payload_too_large', 422: 'format_error', 429: 'rate_limit', 500: 'server_error', 502: 'server_error',
                 503: 'overloaded', 504: 'server_error', 529: 'overloaded'}
# Hermes starts a failed run's error summary with the provider's HTTP status, such as "HTTP 529: ...".
HTTP_STATUS = re.compile(r'HTTP ([1-5][0-9]{2})\b')
# Nocheh's security broker answers a sealed turn's model call with its own status and code
# (src/security/broker.ts). For a provider's refusal it names the provider's status too, such as
# '{"error":"provider_request_failed","provider_status":529}'; any other code is Nocheh's own refusal.
BROKER_ERROR = re.compile(r'HTTP [1-5][0-9]{2}: \{"error":"([a-z_]{1,64})"(?:,"provider_status":([1-5][0-9]{2}))?\}')
# Hermes stops a turn's loop itself (failure_reason `loop_error`) for a reason its exit reason names, with the
# start of the error that stopped it in brackets, such as "repeated_outer_errors(Error during API call #3: ...)".
# Only codes are kept: the stop's name, or what its error says of the provider, never the error's words.
LOOP_STOP = re.compile(r'(pending_tool_result|local_processing_error|repeated_outer_errors|error_near_max_iterations|'
                       r'redirect_restart_limit_exceeded|rebuilt_restart_limit_exceeded)\b(?:\((.*?)\)?)?\Z', re.S)
LOOP_REASONS = {'pending_tool_result': 'empty_answer', 'local_processing_error': 'nocheh_error',
                'repeated_outer_errors': 'unknown', 'error_near_max_iterations': 'unknown',
                'redirect_restart_limit_exceeded': 'interrupted', 'rebuilt_restart_limit_exceeded': 'interrupted'}
# The text Hermes keeps for a call that lost its connection: the provider client's own words, never the provider's.
# The client reports a model call Nocheh's secret check refused before it was sent the same way.
LOST_CONNECTION = 'Connection error.'
# What an API call's error says of the provider: Nocheh's broker's own refusal, the provider's status the broker
# passed on, the status of a direct call, or a lost connection or timeout. Hermes keeps only the error's first
# 80 characters, so a broker code may be cut short (no closing quote), and the provider_status after it never fits.
LOOP_BROKER = re.compile(r"\{'error': '([a-z_]{1,64})('?)")
PROVIDER_FAILED = 'provider_request_failed'
# The broker answers a provider's refusal with the provider's own status for these, and with 503 for any other.
PASSED_ON = (401, 403, 429)
LOOP_STATUS = re.compile(r'Error code: ([1-5][0-9]{2})\b')
LOOP_TIMEOUT = re.compile(r'Error during API call #\d+: (?:Request timed out|.*\btimed out\b)', re.I | re.S)
LOOP_CONNECTION = re.compile(r'Error during API call #\d+: (?:Connection error|Server disconnected|.*\bconnection (?:reset|refused|closed|aborted|lost))',
                             re.I | re.S)
# A direct call that lost its connection to the provider, or never made one.
CONNECTION_ERRORS = ('APIConnectionError', 'ConnectError', 'ConnectionError', 'RemoteProtocolError', 'ReadError',
                     'ServerDisconnectedError')

# Anthropic's list prices in USD per million tokens: input, output, cache read, 5-minute cache write.
# Source: platform.claude.com/docs/en/about-claude/pricing.
CLAUDE_PRICES = {
    'claude-fable-5-1': (10, 50, 0.25, 12.5),
    'claude-fable-5': (10, 50, 1, 12.5),
    'claude-opus-5-5': (4, 20, 0.2, 5),
    'claude-opus-5': (5, 25, 0.5, 6.25),
    'claude-opus-4-8': (5, 25, 0.5, 6.25),
    'claude-opus-4-7': (5, 25, 0.5, 6.25),
    'claude-opus-4-6': (5, 25, 0.5, 6.25),
    'claude-sonnet-5-5': (2, 10, 0.2, 2.5),
    'claude-sonnet-5': (2, 10, 0.2, 2.5),
    'claude-sonnet-4-6': (3, 15, 0.3, 3.75),
    'claude-haiku-5-5': (0.1, 0.5, 0.01, 0.125),
    'claude-haiku-4-5': (1, 5, 0.1, 1.25),
}
# Prices of a request whose prompt is longer than 100K tokens, where they differ.
CLAUDE_LONG_PROMPT_PRICES = {'claude-haiku-5-5': (0.5, 2.5, 0.05, 0.625)}
CLAUDE_LONG_PROMPT = 100_000
CLAUDE_BUCKETS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens')


def _count(value):
    return value if type(value) is int and 0 <= value < 10**12 else 0


def turn_usage(result):
    """The usage fields of a Hermes run_conversation result; no content."""
    if not isinstance(result, dict):
        return None
    usage = {name: _count(result.get(name)) for name in TOKENS}
    usage['calls'] = _count(result.get('api_calls'))
    cost = result.get('estimated_cost_usd')
    status = result.get('cost_status')
    if status == 'included':
        usage['cost_usd'] = 0.0
    elif isinstance(cost, (int, float)) and not isinstance(cost, bool) and 0 <= cost < 10**6 and status != 'unknown':
        usage['cost_usd'] = float(cost)
    if isinstance(result.get('model'), str):
        usage['model'] = result['model'][:120]
    return usage


def cause(code=None, status=None):
    """A failure's cause as `code` or `code:status`, such as `overloaded:529`, or None when nothing is known.
    Without a code of Hermes's, the HTTP status names it."""
    status = status if type(status) is int and 100 <= status <= 599 else None
    if not (isinstance(code, str) and code != 'unknown' and CODE.fullmatch(code)):
        code = STATUS_CAUSES.get(status, 'http_error') if status else None
    return None if code is None else f'{code}:{status}' if status else code


def loop_failure(exit_reason):
    """Why Hermes stopped a turn's loop itself, as (reason, cause), from its exit reason."""
    found = LOOP_STOP.match(exit_reason)
    if not found:
        return 'unknown', 'loop_error'
    stop, detail = found.group(1), found.group(2) or ''
    if detail.startswith('Error during API call #'):
        found = LOOP_STATUS.search(detail)
        status = int(found.group(1)) if found else None
        broker = LOOP_BROKER.search(detail)
        if broker:
            code, whole = broker.groups()
            if not (code == PROVIDER_FAILED if whole else PROVIDER_FAILED.startswith(code)):
                # A whole code is the broker's own refusal; one cut short says only which stop it was.
                return ('context_changed', None) if whole and code in CONTEXT_CHANGES else ('nocheh_error', code if whole else stop)
            return (_status_reason(status), cause(None, status)) if status in PASSED_ON else ('provider_error', stop)
        if status:
            return _status_reason(status), cause(None, status)
        if LOOP_TIMEOUT.match(detail):
            return 'timed_out', 'timeout'
        if LOOP_CONNECTION.match(detail):
            return 'provider_error', 'connection'
    return LOOP_REASONS[stop], stop


def _status_reason(status):
    return {429: 'rate_limited', 401: 'key_rejected', 403: 'key_rejected', 404: 'model_not_found', 413: 'too_long'}.get(
        status, 'provider_error')


def _refused(result, error, refusals):
    """A failed run that Nocheh's secret check stopped, from the codes of the model calls it refused in the run's
    process: as (reason, cause), or None. Once the safety epoch moved on, every later call of the run is refused, so
    any such refusal ends it. Any other refusal is known only by the lost connection the client reports for it."""
    if not refusals or (result.get('completed') is True and not result.get('failed')):
        return None
    if any(code in CONTEXT_CHANGES for code in refusals):
        return 'context_changed', None
    found = LOOP_STOP.match(str(result.get('turn_exit_reason') or ''))
    detail = (found.group(2) or '') if found else ''
    if error.strip() == LOST_CONNECTION or detail.startswith('Error during API call #') and LOOP_CONNECTION.match(detail):
        return 'nocheh_error', refusals[-1]
    return None


def nocheh_failure(code):
    """Why a turn failed that ended on Nocheh's own error before any model run, from its error code."""
    if code in CONTEXT_CHANGES:
        return 'context_changed', None
    return 'nocheh_error', code if isinstance(code, str) and CODE.fullmatch(code) else None


def failure(results, refusals=()):
    """Why a Hermes turn failed, from the run results of its process: one of REASONS or STOPS, and the
    provider's exact error, or the code of Nocheh's own refusal, as a cause, or None.
    `refusals` are the codes of the model calls Nocheh's secret check refused in the same process
    (request_boundary.model_refusals): the provider client reports such a refusal as a lost connection, and
    Hermes may even name it by the status of the secret check's answer, as if the provider had sent it."""
    refusals = [code for code in refusals or () if isinstance(code, str) and CODE.fullmatch(code)]
    for result in results or []:
        if not isinstance(result, dict):
            return 'unknown', None
        error = str(result.get('error') or '')
        if JOB_COST_LIMIT in error:
            return 'job_cost_limit', None
        stopped = _refused(result, error, refusals)
        if stopped:
            return stopped
        broker = BROKER_ERROR.match(error)
        if broker and result.get('failed'):
            # Hermes named the broker's status, not the provider's, so only the provider's own status says what happened.
            if broker.group(1) != 'provider_request_failed':
                return ('context_changed', None) if broker.group(1) in CONTEXT_CHANGES else ('nocheh_error', broker.group(1))
            status = int(broker.group(2)) if broker.group(2) else None
            return (_status_reason(status), cause(None, status)) if status else ('provider_error', None)
        code = str(result.get('failure_reason') or '')
        exit_reason = str(result.get('turn_exit_reason') or '')
        found = HTTP_STATUS.match(error)
        status = int(found.group(1)) if found else None
        found = next((reason for reason, codes in HERMES_REASONS.items() if code in codes), None)
        if found:
            return found, cause(code, status)
        if code == 'loop_error' or LOOP_STOP.match(exit_reason):
            return loop_failure(exit_reason)
        if 'finish_reason=refusal' in exit_reason or 'finish_reason=content_filter' in exit_reason:
            return 'refused', None
        if exit_reason.startswith(('max_iterations_reached', 'budget_exhausted', 'review_input_budget_exhausted',
                                   'context_compression_timeout')):
            return 'too_long', None
        if result.get('interrupted'):
            return 'interrupted', None
        if result.get('failed'):
            if code in ('', 'unknown'):
                return (_status_reason(status), cause(None, status)) if status else ('unknown', None)
            return 'provider_error', cause(code, status)
        if result.get('completed') is not True:
            return 'interrupted', None
        if not str(result.get('final_response') or '').strip():
            return 'empty_answer', None
    return 'unknown', None


def failure_reason(results):
    """Why a Hermes turn failed, as one of REASONS or STOPS."""
    return failure(results)[0]


def error_reason(error):
    """Why one direct model call failed, from its exception, as one of REASONS."""
    status = getattr(error, 'status_code', None)
    if isinstance(status, int):
        return _status_reason(status)
    if isinstance(error, TimeoutError) or 'Timeout' in type(error).__name__:
        return 'timed_out'
    return 'unknown'


def error_cause(error):
    """The exact error of one direct model call, from its exception, as a cause, or None."""
    status = getattr(error, 'status_code', None)
    if type(status) is int and 100 <= status <= 599:
        return cause(None, status)
    if isinstance(error, TimeoutError) or 'Timeout' in type(error).__name__:
        return 'timeout'
    if isinstance(error, ConnectionError) or type(error).__name__ in CONNECTION_ERRORS:
        return 'connection'
    return None


def combine(results):
    """One usage for several runs, such as a review's forks; cost stays known only if every run's is."""
    usages = [turn_usage(result) for result in results]
    usages = [usage for usage in usages if usage]
    if not usages:
        return None
    total = {name: sum(usage.get(name, 0) for usage in usages) for name in (*TOKENS, 'calls')}
    if all('cost_usd' in usage for usage in usages):
        total['cost_usd'] = sum(usage['cost_usd'] for usage in usages)
    model = next((usage['model'] for usage in usages if usage.get('model')), None)
    if model:
        total['model'] = model
    return total


def response_usage(response, model, base_url, provider='openai'):
    """A secret check's usage, from the provider response, priced by Hermes's pricing table."""
    raw = getattr(response, 'usage', None)
    if raw is None:
        return {'calls': 1}
    try:
        from agent.usage_pricing import estimate_usage_cost, normalize_usage
        canonical = normalize_usage(raw, provider=provider, api_mode='chat_completions')
        usage = {name: _count(getattr(canonical, name, 0)) for name in TOKENS}
        cost = estimate_usage_cost(model, canonical, provider=provider, base_url=base_url)
        if cost.status == 'included':
            usage['cost_usd'] = 0.0
        elif cost.amount_usd is not None and cost.status != 'unknown':
            usage['cost_usd'] = float(cost.amount_usd)
    except Exception:
        # Without Hermes's pricing module, keep the reported token counts.
        prompt, output = _count(getattr(raw, 'prompt_tokens', 0)), _count(getattr(raw, 'completion_tokens', 0))
        usage = {'input_tokens': prompt, 'output_tokens': output}
    usage['calls'] = 1
    return usage


def price(rows):
    """USD cost of each {model, provider, base_url, calls, token buckets} row, or None when neither Hermes nor
    Nocheh's Claude prices know it."""
    if not isinstance(rows, list) or len(rows) > 2000:
        raise ValueError('invalid_usage_rows')
    from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
    costs = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('model'), str):
            raise ValueError('invalid_usage_rows')
        usage = CanonicalUsage(**{bucket: _count(row.get(bucket)) for bucket in CLAUDE_BUCKETS},
                               request_count=_count(row.get('calls')))
        provider = str(row.get('provider') or 'openai')[:40]
        try:
            cost = estimate_usage_cost(row['model'][:120], usage, provider=provider, base_url=str(row.get('base_url') or '')[:300])
            found = (0.0 if cost.status == 'included' else
                     float(cost.amount_usd) if cost.amount_usd is not None and cost.status != 'unknown' else None)
        except Exception:
            found = None
        costs.append(claude_cost(row['model'][:120], row) if found is None and provider == 'anthropic' else found)
    return costs


def claude_name(model):
    """A Claude model's name as CLAUDE_PRICES keys it: no provider prefix, dashes for dots."""
    return re.sub(r'(\d)\.(\d)', r'\1-\2', str(model or '').strip().lower().removeprefix('anthropic/'))


def claude_cost(model, usage):
    """USD list price of Claude usage on Anthropic's own API, or None for a model not in CLAUDE_PRICES."""
    name = claude_name(model)
    rates = CLAUDE_PRICES.get(name)
    if rates is None:
        return None
    tokens = [_count(usage.get(bucket)) for bucket in CLAUDE_BUCKETS]
    # Runs total their calls, so the average call's prompt picks the rate card.
    if name in CLAUDE_LONG_PROMPT_PRICES and (tokens[0] + tokens[2] + tokens[3]) / max(1, _count(usage.get('calls'))) > CLAUDE_LONG_PROMPT:
        rates = CLAUDE_LONG_PROMPT_PRICES[name]
    return sum(count * rate for count, rate in zip(tokens, rates)) / 1e6


RATES = ('input', 'output', 'cache_read', 'cache_write', 'request')
# The installation rehearsal's scripted model has no price anywhere; there, and only there, this variable may
# give its rates as JSON, so a background job's cost limit can be tested.
FIXTURE_RATES = 'NOCHEH_FIXTURE_REPLY_RATES'


def _rate(value):
    return float(value) if type(value) in (int, float) and 0 <= value < 10**6 else None


def reply_rates(model, provider, base_url):
    """USD per million tokens of the reply model's four token buckets, and per call as `request`, each None when
    unknown. A background job freezes them at its start. Claude on the Anthropic provider takes the higher of its
    two cards per bucket, since a job's prompts can pass the long-prompt mark, and has no per-call price; any other
    model takes Hermes's pricing, asked with one-million-token rows and one row of a single call."""
    if os.environ.get('NOCHEH_INSTALLATION_FIXTURE') == '1' and os.environ.get(FIXTURE_RATES):
        import json
        try:
            given = json.loads(os.environ[FIXTURE_RATES])
        except ValueError:
            given = None
        return {name: _rate(given.get(name)) if isinstance(given, dict) else None for name in RATES}
    name = claude_name(model)
    if provider == 'anthropic' and name in CLAUDE_PRICES:
        cards = (CLAUDE_PRICES[name], CLAUDE_LONG_PROMPT_PRICES.get(name, CLAUDE_PRICES[name]))
        return {**{bucket: float(max(rates)) for bucket, rates in zip(RATES, zip(*cards))}, 'request': 0.0}
    million = 1_000_000
    rows = [{'model': str(model or ''), 'provider': provider, 'base_url': base_url, bucket: million} for bucket in CLAUDE_BUCKETS]
    # Hermes prices a long request's whole prompt at a higher tier, so output is also asked beside a long prompt.
    rows.append({**rows[0], 'output_tokens': million})
    # A per-request price, which OpenRouter and OpenAI-compatible model lists can carry, is counted per call.
    rows.append({'model': str(model or ''), 'provider': provider, 'base_url': base_url, 'calls': 1})
    try:
        costs = price(rows)
    except Exception:
        return dict.fromkeys(RATES)
    rates = dict(zip(RATES, (_rate(cost) for cost in costs[:4] + costs[5:6])))
    if rates['input'] is not None and rates['output'] is not None and _rate(costs[4]) is not None:
        rates['output'] = max(rates['output'], costs[4] - rates['input'])
    return rates


def part_of(body):
    """Which part a Hermes turn served."""
    if body.get('review') is True:
        return 'memory_review'
    return {'scheduler': 'schedule', 'browser': 'browser', 'background': 'background'}.get(body.get('channel'), 'reply')


def connect(path=None):
    path = Path(path or DATABASE)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute(SCHEMA)
    present = {row[1] for row in db.execute('PRAGMA table_info(usage_daily)')}
    for name, kind in ADDED.items():
        if name not in present:
            db.execute(f'ALTER TABLE usage_daily ADD COLUMN {name} {kind}')
    return db


def record(part, usage, model, failed=False, provider=None, path=None, now=None, refused=False, reason=None, cause=None):
    """Add one run to today's totals, and a failed run's reason and cause. Usage tracking never fails the work it measures."""
    usage = usage or {}
    model = usage.get('model') or model
    provider = (provider if provider is not None else os.environ.get(PROVIDERS.get(part, PROVIDERS['reply']), '')) or 'unknown'
    if 'cost_usd' not in usage and provider == 'anthropic' and any(_count(usage.get(bucket)) for bucket in CLAUDE_BUCKETS):
        cost = claude_cost(model, usage)
        if cost is not None:
            usage = {**usage, 'cost_usd': cost}
    # A run Nocheh's own policy stopped counts as a run, not as a failure the owner is told of.
    failed = bool(failed or refused) and reason not in STOPS
    reason = 'refused' if refused else reason if reason in REASONS else 'unknown'
    detail = f'{reason}:{cause}' if failed and isinstance(cause, str) and CAUSE.fullmatch(cause) else None
    _add(part, model, provider, path, now, reason if failed else None, runs=1, failed=int(failed), cause=detail,
         refused=int(reason == 'refused' and failed), calls=_count(usage.get('calls')), **{name: _count(usage.get(name)) for name in TOKENS},
         cost_usd=float(usage.get('cost_usd') or 0), priced_runs=int('cost_usd' in usage),
         **({'audio_seconds': float(usage.get('audio_seconds') or 0)} if part == 'transcription' else {}))


def note_hidden(part, model, provider=None, path=None, now=None):
    """Count one text hidden whole because the model declined to check it; not a run of its own."""
    _add(part, model, provider, path, now, None, hidden=1)


def _add(part, model, provider, path, now, reason, cause=None, **amounts):
    if part not in PARTS:
        return
    provider = (provider if provider is not None else os.environ.get(PROVIDERS.get(part, PROVIDERS['reply']), '')) or 'unknown'
    model = (model or 'unknown')[:120]
    moment = datetime.fromtimestamp(now or time.time(), timezone.utc)
    day = moment.strftime('%Y-%m-%d')
    target = Path(path or DATABASE)
    if not target.parent.parent.is_dir():
        return  # Not inside a Hermes installation, such as a unit test.
    try:
        db = connect(target)
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO usage_daily(day,part,provider,model) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
                       (day, part, provider[:40], model))
            db.execute('UPDATE usage_daily SET ' + ','.join(f'{name}={name}+?' for name in amounts) +
                       ' WHERE day=? AND part=? AND provider=? AND model=?',
                       (*amounts.values(), day, part, provider[:40], model))
            if reason:
                db.execute("UPDATE usage_daily SET reasons=json_set(reasons,'$.'||?,coalesce(json_extract(reasons,'$.'||?),0)+1) "
                           'WHERE day=? AND part=? AND provider=? AND model=?', (reason, reason, day, part, provider[:40], model))
            if cause:
                # Quoted, since a cause key has colons.
                db.execute("""UPDATE usage_daily SET causes=json_set(causes,'$."'||?||'"',coalesce(json_extract(causes,'$."'||?||'"'),0)+1) """
                           'WHERE day=? AND part=? AND provider=? AND model=?', (cause, cause, day, part, provider[:40], model))
            cutoff = (moment - timedelta(days=RETENTION_DAYS)).strftime('%Y-%m-%d')
            db.execute('DELETE FROM usage_daily WHERE day<?', (cutoff,))
            db.execute('COMMIT')
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        pass


def causes(value):
    """A row's failed runs by reason and cause, keeping only well-formed keys and counts."""
    import json
    try:
        found = json.loads(value or '{}')
    except ValueError:
        return {}
    return {key: _count(count) for key, count in found.items()
            if CAUSE_KEY.fullmatch(key) and _count(count)} if isinstance(found, dict) else {}


def reasons(value):
    """A row's failed runs by reason, keeping only known reasons and counts."""
    import json
    try:
        found = json.loads(value or '{}')
    except ValueError:
        return {}
    return {key: _count(count) for key, count in found.items() if key in REASONS and _count(count)} if isinstance(found, dict) else {}


def rows(since_day, path=None):
    path = Path(path or DATABASE)
    if not path.exists():
        return []
    db = connect(path)
    try:
        db.row_factory = sqlite3.Row
        return [{**dict(row), 'reasons': reasons(row['reasons']), 'causes': causes(row['causes'])}
                for row in db.execute('SELECT * FROM usage_daily WHERE day>=? ORDER BY day,part,provider,model', (since_day,))]
    finally:
        db.close()
