"""A rough cost of an import's model use, shown before the owner presses Start.

The secret check always runs at import. It checks each page of messages in shared
calls, with each message's other text fields beside its words.

Imported history is learned by long-term memory only: Honcho reads the messages in windows
and summarizes them, at its own recent token counts per call or typical ones. No memory
notes are written and no learning question is asked about each old message. Prices come
from Hermes's price table for the models in Settings › Models. It is an estimate: real
cost depends on the messages and the models.

Voice notes are transcribed at import when Settings › Models has a voice provider with a key,
priced per minute of audio from the export's own durations. Each photo or image is read once
with the Images model, priced at typical tokens for one image and its text.
"""
import math
from datetime import datetime, timedelta, timezone

from tools.operations.provider import routes as provider_routes
from tools.operations.provider.usage import honcho_rows

# Typical tokens (input, output) of one Honcho memory call.
HONCHO_TOKENS = (2500, 400)
# Honcho reads up to this much message text per call, and summarizes every 20 and every 60 messages.
HONCHO_WINDOW = 1024
SUMMARIES = (20, 60)
CHARACTERS_PER_TOKEN = 3
# Fewer recent runs than this say little about the next ones.
HISTORY = 20
# The secret check sees each message's words twice (text and entities) and about this much more of its
# other fields, in calls of up to this many characters, each answering with a short list.
CHECK_FIELDS, CHECK_CALL, CHECK_PROMPT_TOKENS, CHECK_OUTPUT_TOKENS = 150, 45000, 300, 300
# Typical tokens (input, output) of reading one image: the image at the model's usual size, the
# instruction, and its text and description.
IMAGE_TOKENS = (1800, 300)


def recent(state, now=None):
    today = datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc)
    return honcho_rows(state, (today - timedelta(days=29)).strftime('%Y-%m-%d')) or []


def voice(values, notes, seconds):
    """What transcribing an import's voice notes costs, or that they are archived only."""
    from tools.operations.provider.transcription_config import MODELS
    route = provider_routes.transcription_route(values)
    minutes = round(seconds / 60, 1)
    if not route.key:
        return {'configured': False, 'notes': notes, 'minutes': minutes, 'cost_usd': None}
    return {'configured': True, 'notes': notes, 'minutes': minutes, 'model': route.model,
            'cost_usd': round(math.ceil(seconds / 60) * MODELS[route.model], 2)}


def estimate(state, messages, characters, call=None, now=None, voice_notes=0, voice_seconds=0, images=0):
    if any(type(value) is not int or value < 0 for value in (messages, characters, voice_notes, voice_seconds, images)):
        raise ValueError('invalid_learning_estimate')
    from tools.operations.installation.configuration import load
    values = load(state); known = provider_routes.providers(values)
    memory = [row for row in recent(state, now) if row['part'] == 'memory']
    calls = sum(row['calls'] - row['failed'] for row in memory)
    per_call = (sum(row['input_tokens'] for row in memory) / calls, sum(row['output_tokens'] for row in memory) / calls) \
        if calls >= HISTORY else HONCHO_TOKENS
    honcho_calls = math.ceil(characters / CHARACTERS_PER_TOKEN / HONCHO_WINDOW) + sum(messages // every for every in SUMMARIES)

    def row(part, count, tokens):
        route = provider_routes.route(values, part)
        return {'model': route.model or 'unknown', 'provider': known.get(route.provider, {}).get('kind', 'openai'),
                'base_url': route.url, 'calls': count, 'input_tokens': round(tokens[0] * count), 'output_tokens': round(tokens[1] * count)}
    checked = 2 * characters + CHECK_FIELDS * messages; check_calls = math.ceil(checked / CHECK_CALL)
    check = row('guard', check_calls, (checked / CHARACTERS_PER_TOKEN / max(1, check_calls) + CHECK_PROMPT_TOKENS, CHECK_OUTPUT_TOKENS))
    pictures = row('image', images, IMAGE_TOKENS)
    priced = [check, row('memory', honcho_calls, per_call), pictures]
    if call is None:
        from tools.operations.archive.archive import API
        call = API().call
    try:
        costs = call('/v1/runtime/usage-price', {'rows': priced}, timeout=20)['costs']
        if not isinstance(costs, list) or len(costs) != len(priced): raise ValueError
    except Exception:
        costs = [None] * len(priced)
    known_cost = lambda value: float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None
    parts = [{'part': 'memory', 'label': 'Long-term memory', 'cost_usd': known_cost(costs[1]), 'measured': calls >= HISTORY}]
    total = None if any(part['cost_usd'] is None for part in parts) else round(sum(part['cost_usd'] for part in parts), 2)
    for part in parts:
        if part['cost_usd'] is not None: part['cost_usd'] = round(part['cost_usd'], 2)
    secret = known_cost(costs[0])
    return {'learning': {'cost_usd': total, 'messages': messages, 'parts': parts},
            'secret_check': {'cost_usd': None if secret is None else round(secret, 2), 'calls': check_calls},
            'voice': voice(values, voice_notes, voice_seconds),
            'images': {'count': images, 'model': pictures['model'],
                       'cost_usd': None if known_cost(costs[2]) is None else round(known_cost(costs[2]), 2)}}
