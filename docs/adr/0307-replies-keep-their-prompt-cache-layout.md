# ADR-0307: Replies keep their prompt cache layout

<status>
Accepted on 2026-11-25. Anthropic reported that the account's prompt cache hit rate dropped 91% in
a week, and the owner asked to find what changed and fix it. The owner left the choice to Claude,
on the condition that no cost saving changes what replies say. Keeps
[ADR-0199](0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md) as it is.
</status>

## Context

- The week's drop was volume, not a code change. Two full memory re-learns sent memory thinking
  through Anthropic's OpenAI-compatible API, which has no prompt cache, and the secret check ran
  on each of those calls. Replies, which use the cache, were a small share of that week.
- Replies already read most of their input from the cache: 62% to 76% of reply input on the days
  with replies in November. A reply made 1.7 to 3.5 model calls on average, so most replies call
  tools, and the calls after the first read the turn's start from the cache.
- Three layout changes were built and measured:
  - Memory evidence after the turn's own message instead of first, so the next turn could read
    the conversation before it. The evidence changes almost every turn.
  - Hermes's `auto` cache life, which moves a chat to the one-hour cache after a pause of more
    than five minutes. One-hour writes cost 2x input against 1.25x.
  - The schedule tool on every message of a chat with schedules, so a forwarded message no longer
    changes the tool list.
- `tools/development/prompt_cache_check.py` replays real Hermes turns through Nocheh's request
  boundary against a simulated Anthropic cache: ten replies in one daily session, pauses of 1 to
  40 minutes, about 6,000 tokens of memory evidence, and two forwards. Input cost in token-units
  (cache read 0.1, five-minute write 1.25, one-hour write 2):

  | Layout | No tool calls | Two rounds of tool calls |
  |---|---|---|
  | Today: evidence first, five minutes | 178,000 | 233,000 |
  | Schedule tool on every message | 165,000 | 221,000 |
  | Evidence after the message, five minutes | 125,000 | 243,000 |
  | Evidence after the message, `auto` | 110,000 | 266,000 |

  With tool calls, the evidence after the message is written to the cache in the turn's second
  call, and the turn's tool calls are cached behind it, so the next turn writes them again. That
  costs what reading the conversation saves, and the one-hour writes cost more.
- No forwarded message reached a private chat from 2026-11-11 to 2026-11-25, so the schedule
  tool change would save nothing live.

## Decision

1. **Memory evidence stays first.** Moving it changes what the model reads before it answers,
   and it saves nothing on the replies that call tools, which are most of them.
2. **Hermes's cache life stays at five minutes** (`prompt_caching.cache_ttl: 5m`). The cache
   life does not change what replies say, and `auto` costs more on replies that call tools.
3. **The schedule tool stays per message.** Forwards are rare, and the change would show a
   forwarded message a tool it may not use.
4. **The check tool stays** for any later change to what a reply sends: `--placement`, `--ttl`,
   `--steady-schedules`, `--tool-rounds` and `--memory` compare layouts without a key or network.

## Consequences

- Nothing changes in what replies send or say.
- A week with a memory re-learn shows a low cache hit rate again, because memory thinking does
  not use the prompt cache. The learning step's prompt is below the cache's minimum size.
- Not changed here: memory thinking on Anthropic's cached route, learning batches, the secret
  check (its prompt is too short to cache), and a new guard epoch's profile, whose carried history
  misses the cache once.
