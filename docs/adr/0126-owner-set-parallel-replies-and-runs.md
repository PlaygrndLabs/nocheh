# ADR-0126: The owner sets parallel replies and parallel agent runs

<status>
Accepted on 2026-10-10. Supersedes the fixed two-chat limit of
[ADR-0125](0125-per-chat-telegram-dispatch-lanes.md); its per-chat lanes,
receipts and order are unchanged.
</status>

<context>
ADR-0125 let different chats run side by side, at most two at once, inside the
security launcher's four isolated container slots. Each slot holds up to 2 GiB
of memory and 2 CPUs, and memory reviews, browser turns and schedules share the
slots with Telegram replies. The owner asked for three chats at once, and for
both the reply limit and process parallelism to be configurable from settings.
</context>

<decision>

- `NOCHEH_PARALLEL_REPLIES` (default 3) sets how many chats Hermes answers at
  once. `NOCHEH_PARALLEL_RUNS` (default 4) sets the security launcher's
  isolated container slots. Both accept 1 to 8, and validation refuses a reply
  limit above the parallel runs.
- Both are ordinary Nocheh settings in `.env`, edited in Settings › Speed or by
  hand. Apply recreates Hermes and its security launcher as well as the
  services it already restarted, so a change takes effect without a full
  restart.
- Compose passes the reply limit to `hermes` and the runs to `hermes-agent-sb`.
  Each reads its value once at startup and stops on a malformed value rather
  than guessing.

</decision>

<consequences>
- With the defaults, three chats can be answered at once and one slot stays
  free for background work. A reply limit equal to the runs lets replies take
  every slot; background work then waits, and a launcher at capacity refuses a
  new run with HTTP 503 as before.
- More parallel runs use more memory and more of the shared model subscription
  at once. Guard detection still runs one call at a time in the Hermes process,
  which limits the gain from more replies.
</consequences>
