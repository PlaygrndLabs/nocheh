"""One place for model usage across Nocheh's parts.

Hermes's turns and the secret check are counted by Hermes's own usage report
(services/hermes/usage.py); Honcho memory and memory search are counted at
Honcho's egress (services/honcho/meter.py). Both keep daily totals per part,
provider and model, never content. Memory tokens are priced by Hermes's own
pricing table; a cost Hermes cannot price stays unknown rather than zero.
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tools.operations.provider import routes as provider_routes

# Part id: (label, the service that runs it).
PARTS = {
    'reply': ('Telegram replies', 'Hermes'),
    'browser': ('Browser chat', 'Hermes'),
    'schedule': ('Scheduled runs', 'Hermes'),
    'memory_review': ('Memory notes', 'Hermes'),
    'guard': ('Secret check', 'Nocheh'),
    'transcription': ('Voice notes', 'Hermes'),
    'memory': ('Memory', 'Honcho'),
    'embedding': ('Memory search', 'Honcho'),
}
TOKENS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens')
MAX_DAYS = 400


def _read(path, query, args):
    if not Path(path).is_file():
        return None
    db = sqlite3.connect(str(path), timeout=5)
    try:
        db.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in db.execute(query, args)]
        except sqlite3.OperationalError:
            return []  # The tracker has not recorded anything yet.
    finally:
        db.close()


def failure_reasons(value):
    """Failed runs by why they failed, such as {'refused': 2}; codes and counts only."""
    try:
        found = json.loads(value or '{}')
    except (TypeError, ValueError):
        return {}
    if not isinstance(found, dict):
        return {}
    return {str(key)[:40]: count for key, count in found.items() if type(count) is int and count > 0}


def hermes_rows(state, since):
    rows = _read(Path(state) / 'hermes/usage/usage.sqlite', 'SELECT * FROM usage_daily WHERE day>=?', (since,))
    if rows is None:
        return None
    for row in rows:
        priced = row.pop('priced_runs', 0)
        row['cost_usd'] = row['cost_usd'] if priced else None
        row['cost_complete'] = priced == row['runs']
        row['reasons'] = failure_reasons(row.get('reasons'))
    return rows


def honcho_rows(state, since):
    from tools.operations.memory.honcho_setup import state_for
    rows = _read(state_for(state) / 'ledger/budget.sqlite', 'SELECT * FROM usage_daily WHERE day>=?', (since,))
    if rows is None:
        return None
    result = []
    for row in rows:
        embedding = row['route'] == '/v1/embeddings'
        priced = row['priced_calls']
        result.append({
            'day': row['day'], 'part': 'embedding' if embedding else 'memory', 'provider': row['provider'],
            'model': row['model'], 'runs': row['calls'], 'failed': row['failed'], 'calls': row['calls'],
            'input_tokens': row['input_tokens'], 'output_tokens': row['output_tokens'],
            'cache_read_tokens': 0, 'cache_write_tokens': 0, 'reasoning_tokens': 0,
            'cost_usd': row['cost_microdollars'] / 1e6 if priced else None,
            'cost_complete': priced == row['calls'] - row['failed'] if embedding else False,
        })
    return result


def price_memory(rows, known, call):
    """Ask Hermes to price memory rows; leaves costs unknown when Hermes is unavailable."""
    wanted = [row for row in rows if row['part'] == 'memory' and (row['input_tokens'] or row['output_tokens'])]
    if not wanted:
        return 'not_needed'
    request = [{'model': row['model'], 'provider': known.get(row['provider'], {}).get('kind', 'openai'),
                'base_url': known.get(row['provider'], {}).get('url') or '', 'calls': row['calls'],
                'input_tokens': row['input_tokens'], 'output_tokens': row['output_tokens']} for row in wanted]
    try:
        costs = call('/v1/runtime/usage-price', {'rows': request}, timeout=20)['costs']
    except Exception:
        return 'unavailable'
    if not isinstance(costs, list) or len(costs) != len(wanted):
        return 'unavailable'
    for row, cost in zip(wanted, costs):
        if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
            row['cost_usd'], row['cost_complete'] = float(cost), True
    return 'ok'


def view(state, days=30, call=None, now=None):
    """Daily usage rows for the last `days` UTC days, from every part, in one list."""
    if type(days) is not int or not 1 <= days <= MAX_DAYS:
        raise ValueError('invalid_usage_days')
    today = datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc)
    since = (today - timedelta(days=days - 1)).strftime('%Y-%m-%d')
    from tools.operations.installation.configuration import load
    try:
        known = provider_routes.providers(load(state))
    except ValueError:
        known = {}
    hermes, honcho = hermes_rows(state, since), honcho_rows(state, since)
    rows = (hermes or []) + (honcho or [])
    if call is None:
        from tools.operations.archive.archive import API
        call = API().call
    pricing = price_memory(rows, known, call)
    for row in rows:
        label, service = PARTS.get(row['part'], (row['part'], ''))
        row.update(label=label, service=service,
                   provider_name=known.get(row['provider'], {}).get('name') or row['provider'])
    rows.sort(key=lambda row: (row['day'], list(PARTS).index(row['part']) if row['part'] in PARTS else 99, row['model']))
    return {'since': since, 'today': today.strftime('%Y-%m-%d'), 'days': days, 'rows': rows,
            'parts': [{'id': part, 'label': label, 'service': service} for part, (label, service) in PARTS.items()],
            'sources': {'hermes': 'ok' if hermes is not None else 'empty', 'honcho': 'ok' if honcho is not None else 'empty',
                        'pricing': pricing}}
