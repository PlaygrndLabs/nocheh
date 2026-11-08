"""Problems worth telling the owner about, and the Telegram notice that tells them.

The dashboard runs `check` every two minutes. It reads what System › Health reads, plus
today's model usage, and sends the owner's private chat one message that lists every
problem that is new or worse. A problem repeats at most once an hour, and only when it got
worse; one that goes away and comes back is new again. Failed and uncertain background
tasks are kept forever, so only their growth is news: the first check after an
installation that can read them records the totals it finds without a message.

When a problem clears, the notice that told the owner about it is edited in place: its line is
marked ✅ with the time, and once every line has cleared the notice loses its buttons."""
import hashlib
import json
import os
import re
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
# Sent notices are followed for a week, so a problem that clears later still marks its line.
FOLLOW_SECONDS = 7 * 86400
MAX_FOLLOWED = 50
# What each kind of problem needs to read before it may count as cleared.
SOURCES = {'application': 'application', 'service': 'services', 'models': 'routes', 'work_unchecked': 'work', 'workers': 'work',
           'failed': 'work', 'uncertain': 'work', 'spool': 'spool', 'github': 'github', 'telegram': 'telegram'}
# Background work families, as System › Work names them.
FAMILIES = {
    'telegram': 'Telegram replies', 'preparation': 'Preparing messages', 'browser': 'Browser chat',
    'schedules': 'Scheduled runs', 'imports': 'Chat imports', 'memory_review': 'Memory notes',
    'honcho': 'Long-term memory sync', 'actions': 'Approved messages', 'tools': 'Approved tools',
    'organization': 'Organizing knowledge',
}
# Why model calls failed, by the usage tracker's codes (services/hermes/usage.py REASONS).
MODEL_REASONS = {
    'refused': 'refused by the model', 'rate_limited': 'over the provider’s rate or usage limit',
    'key_rejected': 'the provider refused the key', 'model_not_found': 'the provider doesn’t know this model',
    'too_long': 'too long for the model', 'timed_out': 'took too long', 'provider_error': 'the provider had an error',
    'interrupted': 'stopped before finishing', 'empty_answer': 'the model gave an empty answer',
    'bad_answer': 'the model’s answer couldn’t be used', 'nocheh_error': 'Nocheh’s own error', 'unknown': 'reason not known',
}
# The provider's exact error, by Hermes's names for it (services/hermes/usage.py causes), when it says more than the reason.
CAUSES = {
    'overloaded': 'the provider was overloaded', 'server_error': 'the provider had a server error',
    'upstream_blocked': 'a proxy in front of the provider blocked the call',
    'incomplete_response': 'the provider stopped before answering', 'format_error': 'the provider rejected the request',
    'connection': 'couldn’t reach the provider or lost the connection', 'timeout': 'took too long',
    'rate_limit': 'over the provider’s rate limit', 'upstream_rate_limit': 'over the provider’s rate limit',
    'billing': 'the provider account is out of credit or over its limit', 'auth': 'the provider refused the key',
    'auth_permanent': 'the provider refused the key', 'model_entitlement': 'the provider account can’t use this model',
    'model_not_found': 'the provider doesn’t know this model', 'context_overflow': 'too long for the model',
    'payload_too_large': 'too long for the model', 'content_policy_blocked': 'refused by the model',
    'provider_policy_blocked': 'the provider account’s privacy settings blocked this model',
    'data_policy_denied': 'a connected app’s data can’t go to a model that may train on it',
}
CAUSE = re.compile(r'([a-z][a-z0-9_]{0,47})(?::([1-5][0-9]{2}))?')
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
        hidden, failed = row.get('hidden') or 0, row.get('failed') or 0
        runs = row.get('runs')
        add(f"model:{today}:{row['part']}:{row['provider']}:{row['model']}", failed + hidden, 'model',
            label=row.get('label') or row['part'], model=row['model'], failed=failed,
            refused=row.get('refused') or 0, hidden=hidden, reasons=row.get('reasons') or {}, causes=row.get('causes') or {},
            # Calls that worked today, so a notice can say when the model works again.
            ok=runs - failed if type(runs) is int else None)
    # Nocheh's GitHub app: its key never expires, so only a refused one gives a notice.
    if (monitoring.get('github') or {}).get('reconnect'):
        add('github', 1, 'github', reason='reconnect')
    return found


def _cause_words(reason, code, status):
    """A cause in the owner's words, such as 'the provider was overloaded (HTTP 529)'."""
    # A status Hermes has no name for: a 4xx means the provider would not take the request.
    words = CAUSES.get(code) or (CAUSES['format_error'] if code == 'http_error' and str(status or '').startswith('4')
                                 else MODEL_REASONS.get(reason, MODEL_REASONS['unknown']))
    notes = [] if code in CAUSES or code == 'http_error' else [code.replace('_', ' ')]
    if status:
        notes.append('HTTP ' + status)
    return words + (f" ({', '.join(notes)})" if notes else '')


def why(problem):
    """Why a part's model calls failed, most common first, such as '2 refused by the model, 1 took too long',
    with the provider's exact error where it is known, such as '1 the provider was overloaded (HTTP 529)',
    or '' when nothing is known."""
    reasons = {key: count for key, count in (problem.get('reasons') or {}).items() if isinstance(count, int) and count > 0}
    # Calls counted before reasons were kept: only their refusals are known.
    refused = problem.get('refused') or 0
    if refused > reasons.get('refused', 0):
        reasons['refused'] = refused
    known = sum(reasons.values())
    if known < (problem.get('failed') or 0) and reasons:
        reasons['unknown'] = reasons.get('unknown', 0) + problem['failed'] - known
    # Each reason's calls by the provider's exact error, such as {'provider_error': {('overloaded', '529'): 1}}.
    causes = {}
    for key, count in (problem.get('causes') or {}).items():
        reason, _, detail = str(key).partition(':')
        found = CAUSE.fullmatch(detail)
        if reason in reasons and found and isinstance(count, int) and count > 0:
            causes.setdefault(reason, {})[found.groups()] = count
    if not reasons or list(reasons) == ['unknown'] and not causes:
        return ''
    # Counts by their words, so a cause that says no more than its reason joins it.
    pieces = {}
    def add(words, count, rank):
        total, first = pieces.get(words, (0, rank))
        pieces[words] = (total + count, min(first, rank))
    for reason, count in reasons.items():
        rank = list(MODEL_REASONS).index(reason) if reason in MODEL_REASONS else 99
        for (code, status), found in sorted(causes.get(reason, {}).items(), key=lambda item: -item[1]):
            found = min(found, count)
            if found:
                add(_cause_words(reason, code, status), found, rank)
                count -= found
        if count:
            add(MODEL_REASONS.get(reason, MODEL_REASONS['unknown']), count, rank)
    ordered = sorted(pieces.items(), key=lambda item: (-item[1][0], item[1][1]))
    return ', '.join(f'{count} {words}' for words, (count, _) in ordered)


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
    if kind == 'github':
        return 'GitHub refused Nocheh’s app. Jobs keep the copies they have; connect GitHub again in Settings › Connections.'
    parts = []
    if problem['failed']:
        reasons = why(problem)
        parts.append(f"{_plural(problem['failed'], 'model call', 'model calls')} failed today" + (': ' + reasons if reasons else ''))
    if problem['hidden']:
        parts.append(f"{_plural(problem['hidden'], 'text was', 'texts were')} hidden whole because the model refused to check "
                     f"{'it' if problem['hidden'] == 1 else 'them'}")
    return f"{problem['label']} ({problem['model']}): " + '; '.join(parts) + '.'


def due(current, record, now, first=False, work=True):
    """Which problems to report now, each with how much it grew, and the record after reporting them.
    A problem that went away counts from zero when it comes back, but still waits out the quiet hour.
    A down service or worker is reported only when the previous check saw it too, so a restart
    is not news. `work` says whether this check could read background work."""
    keys = {problem['key'] for problem in current}
    # A total missing from a check that read background work is zero, such as after its failed tasks were
    # retried and done; one missing because background work could not be read keeps its count.
    sent = {key: value if key in keys or key.startswith(TOTALS) and not work else {**value, 'count': 0}
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


def readable(monitoring):
    """What this check could read, so a problem missing from it counts as cleared only when its source
    was read; 'telegram' means Telegram is connected now."""
    work = monitoring.get('workflows') or {}
    found = {'application'}
    if isinstance(monitoring.get('services'), list):
        found.add('services')
    if isinstance(monitoring.get('routes'), list):
        found.add('routes')
    if isinstance(work.get('counts'), list) and not work.get('unavailable'):
        found.add('work')
    if isinstance(((monitoring.get('archive') or {}).get('archive') or {}).get('spool_failures'), list):
        found.add('spool')
    github = monitoring.get('github')
    if isinstance(github, dict) and not github.get('unavailable'):
        found.add('github')
    if ((monitoring.get('runtime') or {}).get('status') or {}).get('telegram') == 'connected':
        found.add('telegram')
    return found


def _watch(problem, new):
    """What a notice line remembers about its problem, to tell later when it cleared."""
    watch = {'key': problem['key'], 'kind': problem['kind']}
    if problem['total']:
        watch['base'] = problem['count'] - new
    if problem['kind'] == 'model':
        watch.update(count=problem['count'], ok=problem.get('ok'))
    return watch


def back(watch, current, seen, before):
    """Whether a problem whose line was marked cleared is back, such as a retried task that failed again.
    A down service or worker counts as back only when the previous check (`before`) saw it too."""
    kind, problem = watch['kind'], current.get(watch['key'])
    if kind == 'model':
        if not problem or problem['count'] <= watch['count']:
            return False
        watch.update(count=problem['count'], ok=problem.get('ok'))
        return True
    if kind in ('failed', 'uncertain'):
        return SOURCES[kind] in seen and (problem['count'] if problem else 0) > watch['base']
    if kind in STEADY:
        return problem is not None and watch['key'] in before
    # A new Telegram outage is a problem of its own, with its own notice.
    return problem is not None and kind != 'telegram'


def cleared(watch, current, seen):
    """Whether a problem a notice told about has cleared. Background tasks clear when their count is back
    to what it was before the notice, such as after Retry failed; a part's model calls clear once a call
    works after the last failure a check saw; anything else clears when a check that could read it no
    longer finds it. A part's model calls from an earlier day stay as they were."""
    kind, problem = watch['kind'], current.get(watch['key'])
    if kind == 'model':
        if not problem or type(problem.get('ok')) is not int or type(watch.get('ok')) is not int:
            return False
        if problem['count'] > watch['count']:
            # It failed again since: wait for a call that works after this failure.
            watch.update(count=problem['count'], ok=problem['ok'])
            return False
        return problem['ok'] > watch['ok']
    if SOURCES.get(kind) not in seen:
        return False
    if kind in ('failed', 'uncertain'):
        return (problem['count'] if problem else 0) <= watch['base']
    # The incident stays recorded; Telegram connected again is what clears it.
    return kind == 'telegram' or problem is None


def _when(at, since):
    """A time in the notice's words: the hour on the notice's own day, else with the date."""
    moment, start = datetime.fromtimestamp(at, timezone.utc), datetime.fromtimestamp(since, timezone.utc)
    return moment.strftime('%H:%M UTC' if moment.date() == start.date() else '%Y-%m-%d %H:%M UTC')


def shown(line, since):
    """A notice line as the owner sees it: as sent, or with when it cleared."""
    if line.get('done') is None:
        return line['text']
    worked = all(watch['kind'] == 'model' for watch in line['watch'])
    note = f"{'Worked again' if worked else 'Resolved'} at {_when(line['done'], since)}."
    room = 500 - len(note) - 1
    return (line['text'] if len(line['text']) <= room else line['text'][:room - 1].rstrip() + '…') + ' ' + note


def follow_up(record, current, seen, now, values, send):
    """Marks ✅ the lines of sent notices whose problem cleared, by editing each notice in place, and takes the ✅
    back when the problem returns before a new notice may tell about it. A notice whose lines have all cleared
    loses its buttons, and is followed until its quiet hour is over. An edit that does not go through is tried
    again on the next check. Returns how many notices were edited."""
    found = {problem['key']: problem for problem in current}
    before = set(record.get('seen') or [])
    followed, edited = [], 0
    for notice in record.get('notices') or []:
        if now - notice['at'] > FOLLOW_SECONDS:
            continue
        # After the quiet hour a problem that returns gets a new notice, so the ✅ stays.
        quiet = now - notice['at'] < QUIET_SECONDS
        for line in notice['lines']:
            if line.get('done') is not None and quiet and any([back(watch, found, seen, before) for watch in line['watch']]):
                line['done'] = None
            elif line.get('done') is None and all([cleared(watch, found, seen) for watch in line['watch']]):
                line['done'] = now
        lines = [shown(line, notice['at']) for line in notice['lines']]
        done = [line.get('done') is not None for line in notice['lines']]
        if lines != notice.get('shown'):
            body = {'id': notice['id'], 'problems': lines, 'resolved': done, 'open': None if all(done) else opening(values),
                    'retry': any(line.get('retry') and line.get('done') is None for line in notice['lines']), 'edit': True}
            try:
                outcome = send(body).get('state')
            except Exception:
                outcome = 'unavailable'
            if outcome == 'not_found':
                continue  # Sent before notices kept their message, or not sent at all: nothing to edit.
            if outcome == 'done':
                notice['shown'] = lines
                edited += 1
        # Until the quiet hour is over, a problem that returns gets no new notice, so its ✅ may need taking back.
        if not all(done) or lines != notice.get('shown') or quiet:
            followed.append(notice)
    record['notices'] = followed[-MAX_FOLLOWED:]
    return edited


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
    current, seen = problems(monitoring, usage_rows, today), readable(monitoring)
    report, kept = due(current, record, now, first, 'work' in seen)
    sent = kept['sent']
    result = {'reported': len(report), 'state': 'nothing_new'}
    if send is None:
        from tools.operations.archive.archive import API
        send = lambda body: API().call('/v1/runtime/owner-notice', body, timeout=60)
    if enabled:
        result['edited'] = follow_up(record, current, seen, now, values, send)
    if report and enabled:
        lines = [text(problem, new) for problem, new in report][:MAX_LINES]
        # Each line and the problems it tells about; the last line may stand for the rest.
        groups = [[item] for item in report[:MAX_LINES]]
        if len(report) > MAX_LINES:
            lines[-1] = f'…and {len(report) - MAX_LINES + 1} more. See System › Health.'
            groups[-1] = report[MAX_LINES - 1:]
        sequence = record.get('sequence', 0)
        notice = hashlib.sha256(json.dumps([sequence, lines]).encode()).hexdigest()
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
        if outcome == 'done':
            record['notices'] = [*(record.get('notices') or []), {'id': notice, 'at': now, 'shown': lines, 'lines': [
                {'text': line, 'retry': any(problem['kind'] == 'failed' and problem['retryable'] for problem, _ in group),
                 'watch': [_watch(problem, new) for problem, new in group]} for line, group in zip(lines, groups)]}][-MAX_FOLLOWED:]
    elif report:
        result['state'] = 'turned_off'
    for problem, _ in report:
        sent[problem['key']] = {'count': problem['count'], 'at': now}
    _write(state, {**record, **kept})
    return result
