"""Compare secret-check models on synthetic texts: what each finds and how long it takes.

Every request uses the production detector instructions and request options, sent
straight to an owner-authorized provider named in a private upstream file. Only
synthetic text is sent. Results and timings go to an ignored directory; the
summary printed here names cases, never their text or the provider key.
"""
import argparse
import json
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.request
from tools.acceptance.model_rehearsal import read_upstream
from tools.paths import ROOT
from services.hermes.subscription import DETECTOR_INSTRUCTIONS

FRAGMENT = '\n<NOCHEH_FRAGMENT>\n'


def observations(count, secret=None):
    """A long, Honcho-like reasoning request made of synthetic observations."""
    lines = ['You are answering a question about the peer using the observations below.', '## Relevant Observations']
    for index in range(count):
        lines.append(f'- [2026-09-{index % 28 + 1:02d}] Synthetic Owner said the review of draft {index} moved to week {index % 52 + 1}; '
                     f'the blue folder holds chapter {index % 9 + 1} notes and the team meets on {("Monday", "Wednesday", "Friday")[index % 3]}.')
        if secret and index == count // 2:
            lines.append(f'- Synthetic Owner wrote: the staging database password is {secret}, keep it private.')
    return '\n'.join(lines)


# Each case lists the exact literals a correct check returns.
CASES = [
    ('password_en', 'My email password is tulip-RIVER-4471, please remember it for me.', ['tulip-RIVER-4471']),
    ('api_token', 'Use this API token for the synthetic service: sk-synthetic-9Fq2Lm7Xv3Rt8Kp1 and send the report on Friday.',
     ['sk-synthetic-9Fq2Lm7Xv3Rt8Kp1']),
    ('access_code', 'The door access code for the synthetic office is 804615. Lunch is at noon.', ['804615']),
    ('confidential', 'Confidential, do not share: the acquisition price is SYN-PRICE-77310.', ['SYN-PRICE-77310']),
    ('password_fa', 'رمز عبور ایمیلم nargess-KOOH-5521 است، یادت باشد.', ['nargess-KOOH-5521']),
    ('two_secrets', 'Wi-Fi password: orchard-LIME-3390. The router admin PIN is 552907. The printer is on floor two.',
     ['orchard-LIME-3390', '552907']),
    ('private_key', 'Here is the synthetic deploy key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nc3ludGhldGljLWtleS1ub3QtcmVhbC0wMTIzNDU2Nzg5\n'
     '-----END OPENSSH PRIVATE KEY-----\nIt opens the test box.',
     ['-----BEGIN OPENSSH PRIVATE KEY-----\nc3ludGhldGljLWtleS1ub3QtcmVhbC0wMTIzNDU2Nzg5\n-----END OPENSSH PRIVATE KEY-----']),
    ('fragments', FRAGMENT.join(['The meeting moved to 18:00.', 'Backup passphrase: cedar-MOON-6083.', 'Bring the blue folder.']),
     ['cedar-MOON-6083']),
    ('long_with_secret', observations(120, 'quartz-HARBOR-2246'), ['quartz-HARBOR-2246']),
    ('test_marker', 'The test marker for today is blue-toolbox. Remember it and tell me later.', []),
    ('distinctive_phrase', 'My kite is called Saffron Comet and the meeting is on 2026-11-03 at 16:00.', []),
    ('public_id', 'Order number 4471-2209-SYN shipped; the tracking page is public.', []),
    ('persian_plain', 'جلسه به ساعت ۱۸:۰۰ منتقل شد و پوشهٔ آبی را بیاور.', []),
    ('long_without_secret', observations(120), []),
]


def check(url, key, model, effort, text, timeout):
    body = {'model': model, 'messages': [{'role': 'system', 'content': DETECTOR_INSTRUCTIONS}, {'role': 'user', 'content': text}]}
    if effort != 'omit':
        body['reasoning_effort'] = effort
    request = urllib.request.Request(url.rstrip('/') + '/chat/completions', data=json.dumps(body, ensure_ascii=False).encode(),
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                                              'User-Agent': 'nocheh-detector-eval/1'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    start = time.monotonic()
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {'seconds': round(time.monotonic() - start, 3), 'error': 'http_' + str(error.code)}
    except (OSError, ValueError) as error:
        return {'seconds': round(time.monotonic() - start, 3), 'error': type(error).__name__}
    seconds = round(time.monotonic() - start, 3)
    usage = payload.get('usage') or {}
    try:
        literals = json.loads(payload['choices'][0]['message']['content'])['literals']
        if not isinstance(literals, list) or any(not isinstance(value, str) or value not in text for value in literals):
            raise ValueError
    except (KeyError, IndexError, TypeError, ValueError):
        # Production rejects this response as a detector contract failure.
        return {'seconds': seconds, 'error': 'contract_rejected', 'usage': usage}
    return {'seconds': seconds, 'literals': literals, 'usage': usage}


def score(expected, result):
    if 'error' in result:
        return {'pass': False, 'missed': len(expected), 'extra': 0, 'error': result['error']}
    found = set(result['literals'])
    # A returned value that covers an expected secret still hides it.
    missed = [value for value in expected if not any(value in literal for literal in found)]
    extra = [literal for literal in found if not any(value in literal for value in expected)]
    return {'pass': not missed and not extra, 'missed': len(missed), 'extra': len(extra)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', required=True, type=Path, help='Owner-authorized private provider file; never printed.')
    parser.add_argument('--model', action='append', required=True, help='A model to compare; repeat for each.')
    parser.add_argument('--reasoning-effort', default='low', help="The production request sends 'low'; 'omit' leaves it out.")
    parser.add_argument('--repeat', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/acceptance/results/detector-eval')
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error('--repeat must be positive')
    try:
        spec = json.loads(read_upstream(args.upstream).read_text())['chat']
    except (OSError, ValueError) as error:
        parser.error(str(error) if isinstance(error, ValueError) else 'upstream_file_unreadable')
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    results = {'synthetic_only': True, 'reasoning_effort': args.reasoning_effort, 'models': {}}
    for model in args.model:
        rows = []
        for round_ in range(args.repeat):
            for name, text, expected in CASES:
                result = check(spec['url'], spec['key'], model, args.reasoning_effort, text, args.timeout)
                rows.append({'case': name, 'round': round_, 'chars': len(text), **score(expected, result),
                             'seconds': result['seconds'], 'usage': result.get('usage', {})})
                print(json.dumps({'model': model, 'case': name, 'round': round_, 'pass': rows[-1]['pass'],
                                  'seconds': result['seconds'], **({'error': result['error']} if 'error' in result else {})}), flush=True)
        times = [row['seconds'] for row in rows if 'error' not in row]
        short = [row['seconds'] for row in rows if 'error' not in row and row['chars'] < 2000]
        long = [row['seconds'] for row in rows if 'error' not in row and row['chars'] >= 2000]
        results['models'][model] = {'rows': rows, 'summary': {
            'calls': len(rows), 'passed': sum(row['pass'] for row in rows), 'missed_secrets': sum(row['missed'] for row in rows),
            'extra_literals': sum(row['extra'] for row in rows), 'errors': sum('error' in row for row in rows),
            'median_seconds': statistics.median(times) if times else None,
            'median_short_seconds': statistics.median(short) if short else None,
            'median_long_seconds': statistics.median(long) if long else None}}
        print(json.dumps({'model': model, **results['models'][model]['summary']}), flush=True)
    path = args.output / f'detector-eval-{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}.json'
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'saved': str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)}))


if __name__ == '__main__':
    main()
