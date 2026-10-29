"""A rough cost of an import's model use, shown before the owner presses Start.

The secret check always runs at import. It checks each page of messages in shared
calls, with each message's other text fields beside its words.

Learning one message runs one memory-notes review in Hermes, and Honcho's memory
reads the messages in windows and summarizes them. Each review costs what reviews
cost on this installation over the last 30 days; without that history, typical
token counts are priced. Honcho uses its own recent token counts per call, or
typical ones. Prices come from Hermes's price table for the models in Settings ›
Models. It is an estimate: real cost depends on the messages and the models.
"""
import math
from datetime import datetime, timedelta, timezone

from tools.operations.provider import routes as provider_routes
from tools.operations.provider.usage import hermes_rows, honcho_rows

# Typical tokens (input, output) of one memory-notes review and of one Honcho memory call.
REVIEW_TOKENS = (12000, 800)
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


def recent(state, now=None):
    today = datetime.fromtimestamp(now, timezone.utc) if now else datetime.now(timezone.utc)
    since = (today - timedelta(days=29)).strftime('%Y-%m-%d')
    return hermes_rows(state, since) or [], honcho_rows(state, since) or []


def estimate(state, messages, characters, call=None, now=None):
    if type(messages) is not int or messages < 0 or type(characters) is not int or characters < 0:
        raise ValueError('invalid_learning_estimate')
    from tools.operations.installation.configuration import load
    values = load(state); known = provider_routes.providers(values)
    hermes, honcho = recent(state, now)
    reviews = [row for row in hermes if row['part'] == 'memory_review' and row['cost_complete'] and row['cost_usd'] is not None]
    runs = sum(row['runs'] for row in reviews)
    memory = [row for row in honcho if row['part'] == 'memory']
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
    priced = [check, row('memory', honcho_calls, per_call)] + ([] if runs >= HISTORY else [row('reply', messages, REVIEW_TOKENS)])
    if call is None:
        from tools.operations.archive.archive import API
        call = API().call
    try:
        costs = call('/v1/runtime/usage-price', {'rows': priced}, timeout=20)['costs']
        if not isinstance(costs, list) or len(costs) != len(priced): raise ValueError
    except Exception:
        costs = [None] * len(priced)
    known_cost = lambda value: float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None
    review = sum(row['cost_usd'] for row in reviews) / runs * messages if runs >= HISTORY else known_cost(costs[2])
    parts = [{'part': 'memory_review', 'label': 'Memory notes', 'cost_usd': review, 'measured': runs >= HISTORY},
             {'part': 'memory', 'label': 'Long-term memory', 'cost_usd': known_cost(costs[1]), 'measured': calls >= HISTORY}]
    total = None if any(part['cost_usd'] is None for part in parts) else round(sum(part['cost_usd'] for part in parts), 2)
    for part in parts:
        if part['cost_usd'] is not None: part['cost_usd'] = round(part['cost_usd'], 2)
    secret = known_cost(costs[0])
    return {'learning': {'cost_usd': total, 'messages': messages, 'parts': parts},
            'secret_check': {'cost_usd': None if secret is None else round(secret, 2), 'calls': check_calls}}
