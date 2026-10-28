"""Problems worth telling the owner about, and the Telegram notice that tells them.

The dashboard runs `check` every two minutes. It reads what System › Health reads, plus
today's model usage, and sends the owner's private chat one message that lists every
problem that is new or worse. A problem repeats at most once an hour, and only when it got
worse; one that goes away and comes back is new again. Failed and uncertain background
tasks are kept forever, so only their growth is news: the first check after an
installation that can read them records the totals it finds without a message."""
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RECORD = 'admin/problem-notices.json'
QUIET_SECONDS = 3600
# Problems a restart causes for a moment.
STEADY = ('application', 'service', 'workers', 'work_unchecked')
# Counts kept forever, so only their growth is news.
TOTALS = ('failed:', 'uncertain:')
MAX_LINES = 20
# Background work families, as System › Work names them.
FAMILIES = {
    'telegram': 'Telegram replies', 'preparation': 'Preparing messages', 'browser': 'Browser chat',
    'schedules': 'Scheduled runs', 'imports': 'Chat imports', 'memory_review': 'Memory notes',
    'honcho': 'Long-term memory sync', 'actions': 'Approved messages', 'tools': 'Approved tools',
    'organization': 'Organizing knowledge',
}
TELEGRAM_REASONS = {
    'telegram_network_error': 'it couldn’t reach Telegram', 'telegram_polling_conflict': 'another copy of the bot was running',
    'invalid_token': 'Telegram refused the bot token', 'missing_credentials': 'no bot token is set',
}


def _plural(count, one, many):
    return f'{count} {one if count == 1 else many}'


def _family(name):
    return FAMILIES.get(name, str(name).replace('_', ' ').capitalize())


def problems(monitoring, usage_rows, today):
    """The current problems: a key, a count that grows when the problem gets worse, and
    `total` for counts that only ever grow. Texts are built when a notice is sent."""
    found = []

    def add(key, count, kind, total=False, **detail):
        # A total is listed even at zero, so a cleared history counts its growth from zero.
        if count > 0 or total:
            found.append({'key': key, 'count': count, 'kind': kind, 'total': total, **detail})

    application = monitoring.get('application') or {}
    if application.get('unavailable') or application.get('ok') is False:
        add('application', 1, 'application')
    for service in monitoring.get('services') or []:
        if service.get('state') == 'unhealthy':
            add('service:' + service['service'], 1, 'service', name=service.get('tool') or service['service'])
    missing = [route.get('label') or route.get('part') for route in monitoring.get('routes') or [] if isinstance(route, dict) and not route.get('configured')]
    add('models', len(missing), 'models', parts=missing)
    work = monitoring.get('workflows') or {}
    if work.get('unavailable'):
        add('work_unchecked', 1, 'work_unchecked')
    failed, uncertain, retryable = {}, {}, {}
    for row in work.get('counts') or []:
        if row.get('state') in ('failed', 'retryable_failed'):
            failed[row['family']] = failed.get(row['family'], 0) + row['count']
            # The tasks Retry failed can start now; the rest are closed for good.
            if row['state'] == 'retryable_failed' or row['family'] == 'organization':
                retryable[row['family']] = retryable.get(row['family'], 0) + row['count']
        elif row.get('state') == 'ambiguous':
            uncertain[row['family']] = uncertain.get(row['family'], 0) + row['count']
    for family, count in failed.items():
        add('failed:' + family, count, 'failed', total=True, label=_family(family), family=family, retryable=retryable.get(family, 0))
    for family, count in uncertain.items():
        add('uncertain:' + family, count, 'uncertain', total=True, label=_family(family), family=family)
    workers = [w for w in work.get('workers') or [] if w.get('owner') != 'legacy']
    add('workers', sum(1 for w in workers if not w.get('connected')), 'workers')
    spool = ((monitoring.get('archive') or {}).get('archive') or {}).get('spool_failures')
    add('spool', len(spool) if isinstance(spool, list) else 0, 'spool')
    incident = monitoring.get('telegram_incident')
    if incident and incident.get('at'):
        add('telegram:' + str(incident['at']), 1, 'telegram', at=str(incident['at']), reason=incident.get('error_code'))
    for row in usage_rows:
        if row.get('day') != today:
            continue
        hidden = row.get('hidden') or 0
        add(f"model:{today}:{row['part']}:{row['provider']}:{row['model']}", (row.get('failed') or 0) + hidden, 'model',
            label=row.get('label') or row['part'], model=row['model'], failed=row.get('failed') or 0,
            refused=row.get('refused') or 0, hidden=hidden)
    return found


def text(problem, new):
    """One plain line for the owner. `new` is how much the count grew since the last notice."""
    kind, count = problem['kind'], problem['count']
    if kind == 'application':
        return 'Nocheh’s main service isn’t answering. Messages may not be saved or answered.'
    if kind == 'service':
        return f"{problem['name']} isn’t running as expected."
    if kind == 'models':
        return f"No model is set up for {', '.join(problem['parts'])}. That work waits until a model is chosen."
    if kind == 'work_unchecked':
        return 'Background work couldn’t be checked.'
    if kind == 'failed':
        return f"{problem['label']}: {_plural(new, 'task', 'tasks')} failed ({count} so far)."
    if kind == 'uncertain':
        return (f"{problem['label']}: {_plural(new, 'task', 'tasks')} ended with an uncertain result "
                f"({count} so far). Nocheh doesn’t repeat these automatically.")
    if kind == 'workers':
        return f"{_plural(count, 'background worker isn’t', 'background workers aren’t')} connected. Their work waits."
    if kind == 'spool':
        return f"{_plural(count, 'incoming message', 'incoming messages')} couldn’t be saved."
    if kind == 'telegram':
        reason = TELEGRAM_REASONS.get(problem.get('reason'), 'the connection failed')
        return f"Telegram stopped working at {problem['at'][:16].replace('T', ' ')} UTC: {reason}."
    parts = []
    if problem['failed']:
        refused = f", {problem['refused']} refused by the model" if problem['refused'] else ''
        parts.append(f"{_plural(problem['failed'], 'model call', 'model calls')} failed today{refused}")
    if problem['hidden']:
        parts.append(f"{_plural(problem['hidden'], 'text was', 'texts were')} hidden whole because the model refused to check "
                     f"{'it' if problem['hidden'] == 1 else 'them'}")
    return f"{problem['label']} ({problem['model']}): " + '; '.join(parts) + '.'


def due(current, record, now, first=False):
    """Which problems to report now, each with how much it grew, and the record after reporting them.
    A problem that went away counts from zero when it comes back, but still waits out the quiet hour.
    A down service or worker is reported only when the previous check saw it too, so a restart
    is not news."""
    keys = {problem['key'] for problem in current}
    # A total missing from this check could not be read, such as while background work is unavailable.
    sent = {key: value if key in keys or key.startswith(TOTALS) else {**value, 'count': 0}
            for key, value in (record.get('sent') or {}).items()
            if key in keys or key.startswith(TOTALS) or now - value['at'] < QUIET_SECONDS}
    seen = set(record.get('seen') or [])
    report = []
    for problem in current:
        previous = sent.get(problem['key'])
        if previous is None and problem['total'] and first:
            sent[problem['key']] = {'count': problem['count'], 'at': 0}
            continue
        if problem['kind'] in STEADY and problem['key'] not in seen:
            continue
        if not problem['count'] or previous and problem['count'] < previous['count']:
            # Cleared history: count growth from what is left.
            sent[problem['key']] = {**(previous or {'at': 0}), 'count': problem['count']}
            continue
        if previous and (problem['count'] <= previous['count'] or now - previous['at'] < QUIET_SECONDS):
            continue
        report.append((problem, problem['count'] - (previous['count'] if previous and problem['total'] else 0)))
    return report, {'sent': sent, 'seen': sorted(keys)}


def _read(state):
    try:
        return json.loads((Path(state) / RECORD).read_text())
    except (OSError, ValueError):
        return None


def _write(state, record):
    path = Path(state) / RECORD
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as file:
        json.dump(record, file)
    os.replace(file.name, path)


def opening(values):
    """Where the notice's Open button goes: the mini app's Problems page when the mini app is set up,
    else System › Health at the dashboard address from Settings, or this computer's own."""
    from tools.operations.installation import mini_app
    if mini_app.enabled(values):
        return {'kind': 'web_app', 'url': values['NOCHEH_MINI_APP_URL'].rstrip('/') + '/?page=problems'}
    address = values.get('NOCHEH_DASHBOARD_URL') or 'http://127.0.0.1:' + os.environ.get('NOCHEH_DASHBOARD_PORT', '8783')
    return {'kind': 'url', 'url': address.rstrip('/') + '/#system'}


def check(state, monitoring=None, usage_rows=None, send=None, now=None, enabled=None, values=None):
    """Report new or worse problems to the owner. Returns what was reported and how it went."""
    from tools.operations.installation.configuration import load
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    today = datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%d')
    if values is None:
        values = load(state)
    if enabled is None:
        enabled = values.get('TELEGRAM_PROBLEM_NOTICES', 'true') != 'false'
    if monitoring is None:
        from tools.operations.provider.monitoring import status
        monitoring = status(state)
    if usage_rows is None:
        usage_rows = monitoring.get('model_problems') if isinstance(monitoring.get('model_problems'), list) else []
    record = _read(state) or {}
    # Totals are recorded without a message the first time they can be read.
    first = not record.get('baseline')
    if isinstance((monitoring.get('workflows') or {}).get('counts'), list):
        record['baseline'] = True
    report, kept = due(problems(monitoring, usage_rows, today), record, now, first)
    sent = kept['sent']
    result = {'reported': len(report), 'state': 'nothing_new'}
    if report and enabled:
        lines = [text(problem, new) for problem, new in report][:MAX_LINES]
        if len(report) > MAX_LINES:
            lines[-1] = f'…and {len(report) - MAX_LINES + 1} more. See System › Health.'
        sequence = record.get('sequence', 0)
        notice = hashlib.sha256(json.dumps([sequence, lines]).encode()).hexdigest()
        if send is None:
            from tools.operations.archive.archive import API
            send = lambda body: API().call('/v1/runtime/owner-notice', body, timeout=60)
        try:
            retry = any(problem['kind'] == 'failed' and problem['retryable'] for problem, _ in report)
            outcome = send({'id': notice, 'problems': lines, 'open': opening(values), 'retry': retry}).get('state')
        except Exception:
            outcome = 'unavailable'
        result['state'] = outcome
        # Telegram not connected, or Nocheh not answering: the same problems are tried on the next check.
        # An unclear send is never repeated.
        if outcome not in ('done', 'ambiguous'):
            _write(state, {**record, **kept})
            return result
        record['sequence'] = sequence + 1
    elif report:
        result['state'] = 'turned_off'
    for problem, _ in report:
        sent[problem['key']] = {'count': problem['count'], 'at': now}
    _write(state, {**record, **kept})
    return result
