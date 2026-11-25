# ADR-0307: Replies keep the conversation in the prompt cache

<status>
Proposed. Anthropic reported that the account's prompt cache hit rate dropped 91% in a week,
and the owner asked to find what changed and fix it. Amends
[ADR-0199](0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md) for replies, and the
schedule tool of [ADR-0266](0266-schedules-set-by-asking.md) and
[ADR-0277](0277-members-own-schedules.md). Accepted once the owner chooses where the memory
evidence goes.
</status>

## Context

- The week's drop was mostly volume, not a code change: two full memory re-learns sent memory
  thinking through Anthropic's OpenAI-compatible API, which has no prompt cache, and the secret
  check ran on each of those calls. Replies and reviews, which do use the cache, were a small share.
- Replies still wasted most of their cache. Anthropic reads a request's start from the cache only
  when every byte up to a cache mark is what an earlier request sent.
  - The memory evidence was the first block of the conversation. Long-term memory changes after
    almost every exchange, so each reply wrote the whole conversation to the cache again and read
    only the tools and the system prompt.
  - Nocheh pinned Hermes's cache to five minutes. A reply after a longer pause found nothing.
    Hermes's own `auto` keeps a chat on five minutes until its first pause of more than five
    minutes, then on the one-hour cache. One-hour writes cost more (2x input against 1.25x), so
    `auto` alone made replies dearer while the evidence was rewritten each turn.
  - In the owner's private chat, and in a member's with Personal assistant on, the schedule tool
    and its instructions came and went with each message: a forwarded or late message dropped
    them. The tools come first in the cache, so each change lost the whole cache.
- `tools/development/prompt_cache_check.py` replays real Hermes turns through Nocheh's request
  boundary against a simulated Anthropic cache: ten replies in one daily session, with pauses of
  1 to 40 minutes, about 6,000 tokens of memory evidence, and two forwards. Input cost went from
  178,000 to 110,000 token-units (cache read 0.1, five-minute write 1.25, one-hour write 2), and
  the share of input read from the cache from 18% to 52%.

## Decision

1. **Evidence after the turn's own message.** On Anthropic's Messages API a reply's memory
   evidence is a block right after the turn's own message, found by that message's archive
   source line. It comes after Hermes's cache mark on that message, so the next turn reads the
   conversation, that message included, from the cache. The evidence keeps its data label, is
   never stored, and stays where it is through the turn's tool calls. Without the turn's message
   (a compaction summed it up), it goes first as before. Memory-notes reviews, scheduled runs and
   jobs each run in their own session and keep it first. The OpenAI-compatible route is unchanged.
2. **Hermes's `auto` cache life.** Hermes profiles use `prompt_caching.cache_ttl: auto`.
   Schedules and reviews start their own sessions, never pause, and stay on five minutes. A job
   keeps one session across attempts, so a job relaunched after a pause moves to one hour.
3. **The schedule tool stays.** Storage says whether the chat itself has schedules (`offered`),
   apart from whether this message may set one (`allowed`). Every Telegram reply in such a chat
   has the schedule tool, its time zone tool and its instructions. Only an allowed message binds
   the schedule gate; an unbound gate refuses every call and says the person must send it as
   their own message. Storage still records only what an allowed turn sets.
4. **The evidence instruction does not say where the block is.** Its default text says the
   evidence is "in its own block, marked as data and not a new request".

## Consequences

- The model reads memory after the person's message instead of before the conversation. Reply
  quality needs a check with the real model before this is accepted.
- A reply's tool calls are cached with the evidence ahead of them, so the next turn writes them
  again. After a reply with more than about 20 blocks of tool calls and results, the next
  turn's read ends at the system prompt, as before. The check tool's replies call no tools, so
  its numbers are for plain replies.
- A one-hour write costs more than a five-minute one. Nocheh's own price table prices every cache
  write at the five-minute rate when Hermes has no price, so the Usage page can count a little low.
- A forwarded message in a chat with schedules now sees the schedule tool; a call is refused.
- Not changed here: memory thinking (Honcho) stays on the OpenAI-compatible API, the secret check
  stays uncached (its prompt is too short to cache), and a new guard epoch still starts a new
  profile whose carried history misses the cache once.
