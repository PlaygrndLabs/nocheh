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
PARTS = ('reply', 'browser', 'schedule', 'memory_review', 'guard')
TOKENS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens')
PROVIDERS = {'reply': 'NOCHEH_REPLY_ROUTE_PROVIDER', 'guard': 'NOCHEH_GUARD_ROUTE_PROVIDER'}
SCHEMA = ('CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL, part TEXT NOT NULL, provider TEXT NOT NULL, '
          'model TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, '
          'calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, '
          'output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, '
          'cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, '
          'cost_usd REAL NOT NULL DEFAULT 0, priced_runs INTEGER NOT NULL DEFAULT 0, '
          'PRIMARY KEY(day,part,provider,model))')


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
    return db


def record(part, usage, model, failed=False, provider=None, path=None, now=None):
    """Add one run to today's totals. Usage tracking never fails the work it measures."""
    if part not in PARTS:
        return
    usage = usage or {}
    provider = (provider if provider is not None else os.environ.get(PROVIDERS['guard' if part == 'guard' else 'reply'], '')) or 'unknown'
    model = (usage.get('model') or model or 'unknown')[:120]
    moment = datetime.fromtimestamp(now or time.time(), timezone.utc)
    day = moment.strftime('%Y-%m-%d')
    priced = 'cost_usd' in usage
    target = Path(path or DATABASE)
    if not target.parent.parent.is_dir():
        return  # Not inside a Hermes installation, such as a unit test.
    try:
        db = connect(target)
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO usage_daily(day,part,provider,model) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
                       (day, part, provider[:40], model))
            db.execute('UPDATE usage_daily SET runs=runs+1,failed=failed+?,calls=calls+?,' +
                       ','.join(f'{name}={name}+?' for name in TOKENS) +
                       ',cost_usd=cost_usd+?,priced_runs=priced_runs+? WHERE day=? AND part=? AND provider=? AND model=?',
                       (int(bool(failed)), _count(usage.get('calls')), *(_count(usage.get(name)) for name in TOKENS),
                        float(usage.get('cost_usd') or 0), int(priced), day, part, provider[:40], model))
            cutoff = (moment - timedelta(days=RETENTION_DAYS)).strftime('%Y-%m-%d')
            db.execute('DELETE FROM usage_daily WHERE day<?', (cutoff,))
            db.execute('COMMIT')
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        pass


def rows(since_day, path=None):
    path = Path(path or DATABASE)
    if not path.exists():
        return []
    db = connect(path)
    try:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute('SELECT * FROM usage_daily WHERE day>=? ORDER BY day,part,provider,model', (since_day,))]
    finally:
        db.close()
