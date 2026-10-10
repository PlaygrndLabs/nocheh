# ADR-0123: Retired sources leave stored Hermes native history

<status>
Accepted on 2026-10-10 to close the retired-fact failure found by the
real-Claude simulator run. Extends [ADR-0021](0021-scoped-native-assistant-processes.md)
on what a native turn may read; Hermes' internal workflow is unchanged.
</status>

<context>
`SPECS.md` excludes a retired message from future agent retrieval. Archive
search and Honcho memory already did, but Hermes keeps its own copy of every
turn in the profile's `state.db`: the user message with its
`[Archive source: nocheh:event:…]` marker, tool calls, tool results, reasoning
and the answer. Thirty seconds after every source of a synthetic fact was
retired, the owner-private answer still gave it from that history.
`/v1/context/prepare` guards the history but never consulted retirement.

Filtering only the history Nocheh passes to `run_conversation` is not enough:
Hermes rereads stored rows itself (turn-lease reload, compression adoption,
`session_search`), and owner native recall searches every profile's database.
</context>

<decision>

- Before a turn's child process starts, while the profile's turn lock is held,
  the Hermes service brings that profile's stored history current. It asks
  storage (`POST /internal/sources/retired`, service token only) which recorded
  events are retired, directly or as reactions to a retired message, and which
  have a retired delivered reply (the Archive's receipt-linked reply relation).
- Rows are rewritten in place, not deleted, so tool-call pairing and turn
  alternation stay valid:
  - a retired message's own row keeps only a withheld notice and its marker;
  - its turn's tool calls, tool results and reasoning are withheld; its
    delivered answer, a separate source, stays unless also retired;
  - a turn whose delivered answer is retired has everything after its message
    withheld;
  - any tool call or result citing a retired event ID is withheld;
  - compaction summaries written after the earliest newly withheld row, and
    generated session titles of affected sessions, are withheld.
  Derived columns (API bytes, reasoning, display metadata) are cleared, and
  Hermes' full-text index follows through its own triggers.
- Storage's retirement revision changes with every retirement decision. The
  checked revision is stored in Hermes' `state_meta` table in the same
  transaction, so an unchanged revision costs one storage call per turn.
- If storage cannot answer, nothing is rewritten and the turn does not start.
- Owner native recall stays read-only: for a profile not yet current it
  computes the same plan and skips the rows that profile's next turn will
  withhold.
</decision>

<consequences>

- Restoring a message makes it available to retrieval again; the withheld
  native copy is not rebuilt.
- A retirement while no turn runs in a profile is applied by that profile's
  next turn; no timer or extra workflow is involved.
- Hermes native notes (`MEMORY.md`, `USER.md`) are a separate copy and are not
  rewritten by this decision.
</consequences>
