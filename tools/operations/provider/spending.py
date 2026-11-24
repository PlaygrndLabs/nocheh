"""One monthly spending limit over every model call Nocheh makes (ADR-0298).

The dashboard runs `check` with the problem check, every two minutes. It adds this UTC month's cost from the usage
report (tools/operations/provider/usage.py): replies, scheduled runs, memory notes, the secret check, voice notes,
images, memory and memory search. At 80% of the limit the owner's private chat gets one warning a month. At the limit,
the month is paused: the security service lets only the owner's own private chat reach a model, and Honcho's meter
stops memory thinking, until the month ends or the owner raises the limit. Costs the usage report cannot price are
left out and named in the warning, so the owner knows the total may be low.
"""
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

RECORD = 'admin/spending.json'
WARN = 0.8


def limit(values):
    """The monthly limit in dollars, or None while it is off."""
    value = str(values.get('NOCHEH_MONTHLY_LIMIT_USD') or '').strip()
    return int(value) if re.fullmatch(r'[1-9]\d{0,5}', value) else None


def month_spend(rows, month):
    """This month's dollars from usage rows, and how many rows had a cost the report could not price."""
    spent, unpriced = 0.0, 0
    for row in rows:
        if not str(row.get('day', '')).startswith(month):
            continue
        cost = row.get('cost_usd')
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            spent += cost
        elif row.get('runs') or row.get('calls'):
            unpriced += 1
    return spent, unpriced


def summary(state, now=None, view=None):
    """This month's and last month's spend, for Settings › Models."""
    moment = datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc)
    this = moment.strftime('%Y-%m')
    last = (moment.replace(day=1) - timedelta(days=1)).strftime('%Y-%m')
    if view is None:
        from tools.operations.provider.usage import view
    rows = view(state, moment.day + 31, now=moment.timestamp())['rows']
    spent, unpriced = month_spend(rows, this)
    before, unpriced_before = month_spend(rows, last)
    record = _read(state)
    return {'month': this, 'spent_usd': round(spent, 2), 'unpriced': unpriced, 'last_month': last,
            'last_month_usd': round(before, 2), 'last_month_unpriced': unpriced_before,
            'paused': record.get('paused') == this}


def _read(state):
    try:
        found = json.loads((Path(state) / RECORD).read_text())
        return found if isinstance(found, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(state, record):
    path = Path(state) / RECORD
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as file:
        json.dump(record, file)
    os.replace(file.name, path)


def money(value):
    return f'${value:,.2f}'


def warning(level, spent, cap, unpriced):
    note = f' Some costs could not be priced ({unpriced}), so the real total may be higher.' if unpriced else ''
    if level == 100:
        return (f'Nocheh reached your monthly spending limit of {money(cap)} ({money(spent)} used). Until next month, or until you '
                'raise the limit in Settings › Models, only your private chat gets answers. Schedules, background jobs, '
                'members, groups and memory learning wait.' + note)
    return (f'Nocheh used {money(spent)} of your monthly spending limit of {money(cap)} ({round(spent / cap * 100)}%). '
            'At the limit only your private chat gets answers until next month.' + note)


def apply_pause(state, month):
    """Tell the security service and Honcho's meter which month is paused, or None to resume."""
    from tools.operations.archive.archive import API
    API().call('/internal/spending-pause', {'month': month}, timeout=30)
    from tools.operations.memory.honcho_setup import state_for
    ledger = state_for(state) / 'ledger/budget.sqlite'
    if ledger.is_file():
        from services.honcho.meter import Ledger
        Ledger(ledger).set_spend_pause(month)


def check(state, values=None, now=None, rows=None, send=None, pause=None):
    """Warn at 80%, pause at the limit, and resume when the month ends or the limit is raised or turned off."""
    moment = datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc)
    month = moment.strftime('%Y-%m')
    if values is None:
        from tools.operations.installation.configuration import load
        values = load(state)
    pause = pause or (lambda wanted: apply_pause(state, wanted))
    record = _read(state)
    cap = limit(values)
    spent, unpriced = 0.0, 0
    if cap is not None:
        if rows is None:
            from tools.operations.provider.usage import view
            rows = view(state, moment.day, now=moment.timestamp())['rows']
        spent, unpriced = month_spend(rows, month)
    level = 0 if cap is None else 100 if spent >= cap else 80 if spent >= cap * WARN else 0
    wanted = month if level == 100 else None
    result = {'state': 'off' if cap is None else 'ok', 'spent_usd': round(spent, 2), 'limit_usd': cap, 'level': level}
    if record.get('paused') != wanted:
        try:
            pause(wanted)
            record['paused'] = wanted
        except Exception:
            # Tried again at the next check.
            result['pause'] = 'unavailable'
    told = record.get('told') if record.get('month') == month and isinstance(record.get('told'), dict) else {}
    # A warning is told once a month for each level and limit; raising the limit can warn again.
    key = f'{level}:{cap}'
    if level and key not in told:
        if send is None:
            from tools.operations.archive.archive import API
            send = lambda body: API().call('/v1/runtime/owner-notice', body, timeout=60)
        from tools.operations.provider.problems import opening
        line = warning(level, spent, cap, unpriced)
        notice = hashlib.sha256(json.dumps(['spending', month, key]).encode()).hexdigest()
        try:
            outcome = send({'id': notice, 'problems': [line], 'open': opening(values)}).get('state')
        except Exception:
            outcome = 'unavailable'
        result['notice'] = outcome
        # An unclear send is never repeated; Telegram not connected is tried again.
        if outcome in ('done', 'ambiguous'):
            told[key] = moment.timestamp()
    record.update(month=month, told=told)
    _write(state, record)
    return result
