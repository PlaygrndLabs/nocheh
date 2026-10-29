"""Nocheh's own model usage tracker for the parts Hermes runs.

Hermes reports each turn's token buckets, API calls and estimated cost itself;
the secret check reads its provider response's usage and prices it with
Hermes's own pricing table. Nocheh keeps one row per UTC day, part, provider
and model, never content, so the table stays small and bounded.
"""
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATABASE = Path(os.environ.get('NOCHEH_USAGE_DB', '/workspace/data/local/hermes/usage/usage.sqlite'))
RETENTION_DAYS = 400
PARTS = ('reply', 'browser', 'schedule', 'memory_review', 'guard', 'transcription', 'image')
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
          "reasons TEXT NOT NULL DEFAULT '{}', "
          'PRIMARY KEY(day,part,provider,model))')
# Columns added after the first table: `refused` is a failed run the model declined to answer,
# `hidden` a text the secret check hid whole because the model declined to check it, and
# `reasons` the failed runs counted by why they failed, such as {"refused": 2, "timed_out": 1}, and
# `audio_seconds` the length of the recordings voice-note transcription was sent.
ADDED = {'refused': 'INTEGER NOT NULL DEFAULT 0', 'hidden': 'INTEGER NOT NULL DEFAULT 0', 'reasons': "TEXT NOT NULL DEFAULT '{}'",
         'audio_seconds': 'REAL NOT NULL DEFAULT 0'}
# Why a run failed. Codes only: never the provider's message or any content.
REASONS = ('refused', 'rate_limited', 'key_rejected', 'model_not_found', 'too_long', 'timed_out',
           'provider_error', 'interrupted', 'empty_answer', 'bad_answer', 'nocheh_error', 'unknown')
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


def failure_reason(results):
    """Why a Hermes turn failed, from the run results of its process, as one of REASONS."""
    for result in results or []:
        if not isinstance(result, dict):
            return 'unknown'
        code = str(result.get('failure_reason') or '')
        exit_reason = str(result.get('turn_exit_reason') or '')
        found = next((reason for reason, codes in HERMES_REASONS.items() if code in codes), None)
        if found:
            return found
        if 'finish_reason=refusal' in exit_reason or 'finish_reason=content_filter' in exit_reason:
            return 'refused'
        if exit_reason.startswith(('max_iterations_reached', 'budget_exhausted', 'review_input_budget_exhausted',
                                   'context_compression_timeout')):
            return 'too_long'
        if result.get('interrupted'):
            return 'interrupted'
        if result.get('failed'):
            return 'unknown' if code in ('', 'unknown') else 'provider_error'
        if result.get('completed') is not True:
            return 'interrupted'
        if not str(result.get('final_response') or '').strip():
            return 'empty_answer'
    return 'unknown'


def error_reason(error):
    """Why one direct model call failed, from its exception, as one of REASONS."""
    status = getattr(error, 'status_code', None)
    if isinstance(status, int):
        if status == 429:
            return 'rate_limited'
        if status in (401, 403):
            return 'key_rejected'
        if status == 404:
            return 'model_not_found'
        if status == 413:
            return 'too_long'
        return 'provider_error'
    if isinstance(error, TimeoutError) or 'Timeout' in type(error).__name__:
        return 'timed_out'
    return 'unknown'


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
    """USD cost of each {model, provider, base_url, input_tokens, output_tokens} row, or None when Hermes has no price."""
    if not isinstance(rows, list) or len(rows) > 2000:
        raise ValueError('invalid_usage_rows')
    from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
    costs = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('model'), str):
            raise ValueError('invalid_usage_rows')
        usage = CanonicalUsage(input_tokens=_count(row.get('input_tokens')), output_tokens=_count(row.get('output_tokens')),
                               request_count=_count(row.get('calls')))
        try:
            cost = estimate_usage_cost(row['model'][:120], usage, provider=str(row.get('provider') or 'openai')[:40],
                                       base_url=str(row.get('base_url') or '')[:300])
            costs.append(0.0 if cost.status == 'included' else
                         float(cost.amount_usd) if cost.amount_usd is not None and cost.status != 'unknown' else None)
        except Exception:
            costs.append(None)
    return costs


def part_of(body):
    """Which part a Hermes turn served."""
    if body.get('review') is True:
        return 'memory_review'
    return {'scheduler': 'schedule', 'browser': 'browser'}.get(body.get('channel'), 'reply')


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


def record(part, usage, model, failed=False, provider=None, path=None, now=None, refused=False, reason=None):
    """Add one run to today's totals, and a failed run's reason. Usage tracking never fails the work it measures."""
    usage = usage or {}
    failed = bool(failed or refused)
    reason = 'refused' if refused else reason if reason in REASONS else 'unknown'
    _add(part, usage.get('model') or model, provider, path, now, reason if failed else None, runs=1, failed=int(failed),
         refused=int(reason == 'refused' and failed), calls=_count(usage.get('calls')), **{name: _count(usage.get(name)) for name in TOKENS},
         cost_usd=float(usage.get('cost_usd') or 0), priced_runs=int('cost_usd' in usage),
         **({'audio_seconds': float(usage.get('audio_seconds') or 0)} if part == 'transcription' else {}))


def note_hidden(part, model, provider=None, path=None, now=None):
    """Count one text hidden whole because the model declined to check it; not a run of its own."""
    _add(part, model, provider, path, now, None, hidden=1)


def _add(part, model, provider, path, now, reason, **amounts):
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
            cutoff = (moment - timedelta(days=RETENTION_DAYS)).strftime('%Y-%m-%d')
            db.execute('DELETE FROM usage_daily WHERE day<?', (cutoff,))
            db.execute('COMMIT')
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        pass


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
        return [{**dict(row), 'reasons': reasons(row['reasons'])}
                for row in db.execute('SELECT * FROM usage_daily WHERE day>=? ORDER BY day,part,provider,model', (since_day,))]
    finally:
        db.close()
