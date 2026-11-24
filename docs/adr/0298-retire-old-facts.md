# ADR-0298: Retire old facts (Honcho dreams), off by default

<status>
Accepted on 2026-11-24. The owner asked for "Old facts retire", disabled by default, and then: "dont remove
it just keep it hide". Amends
[ADR-0225](0225-member-safety-rules.md) (dreams were pinned off beside peer cards),
[ADR-0241](0241-honcho-runs-only-the-tools-it-offered.md) (its protection assumed dreams off) and
[ADR-0101](0101-honcho-terminal-queue-errors-block-readiness.md) (a failed dream no longer holds readiness).
Works with [ADR-0286](0286-memory-walls.md) (memory walls).
</status>

## Context

- Honcho 3.6.2's dreams look back over a collection's facts. A deduction pass writes new
  conclusions and deletes ones a newer fact replaced (a soft delete); an induction pass writes
  patterns. Each pass is a tool loop on the memory model: up to 12 and 10 calls, so about 22.
- A dream runs per collection: a person's whole memory (`person, person`, every session they
  wrote in) and each memory wall's copy (`scope.<wall>, person`, only the wall's sessions).
  It runs after 50 new facts, at most every 8 hours, once the collection is quiet for 60
  minutes. A dream's new conclusion is filed under the session of the collection's newest fact.
- A wall's dream reads and writes only the wall's own collection, and its message search only
  the wall's sessions. A wall copy takes explicit facts only.
- A whole-memory dream reads every chat of its person, so a conclusion it files under a group
  session can rest on the owner's private chat or on another group. Nocheh's group reads use
  walls, and fact lists take explicit facts only, but a group's context fell back to Honcho's
  prose for its session when the fact list or its source lines could not be read, and that prose
  holds derived conclusions.
- Honcho queues a gate-bypassing dream for each person after every copy into a wall
  (`scope_backfill`) and a card refresh plus a dream after a removal (`scope_removal`). Nocheh
  copies into walls often (every new wall, every session joining one), so these would multiply
  cost and crowd the learning queue that PR #311 just unclogged. Peer cards are off, so a card
  refresh has nothing to do.

## Decision

1. **One setting, off by default.** `NOCHEH_MEMORY_RETIRE_OLD_FACTS` (`false`), shown as
   "Retire old facts" on Memory › Long-term › Status and limits with its timing and cost.
   Save applies it: setup writes `DREAM_ENABLED` from it into `honcho.env`, and Compose
   recreates Honcho. Off, Honcho's scheduler and dreamer do nothing.
2. **Peer cards stay off.** `PEER_CARD_ENABLED=false` is still written on every setup; with it
   Honcho drops the card tool from every dream.
3. **Only dreams on Honcho's normal timing run.** Nocheh's deriver hook (`bind_dreams` in
   `services/honcho/boundary.py`) skips dreams with trigger `scope_backfill` or `scope_removal`
   and every `card_refresh` dream. Walls still dream after 50 new facts, like every other
   collection.
4. **A group's context never falls back to prose.** Only the owner's block may carry Honcho's
   prose representation; a group's fallback keeps its summary only.
5. **A failed dream does not make memory limited.** `queue-health` counts failed
   `representation` and `summary` tasks only. Failed dreams stay in the failed-learning count
   and are retried with the rest.
6. **A retired fact is hidden, never deleted.** Honcho soft-deletes a replaced fact and its
   reconciler erases soft-deleted rows five minutes later. Nocheh's hook `bind_hiding` (bound in
   `services/honcho/run.py` around `crud.delete_documents`) moves each just-retired row's
   `deleted_at` to a far-future mark (`9999-12-31`) and records
   `internal_metadata.nocheh_hidden = {reason, at}`. Honcho's reads skip any row with
   `deleted_at` set, and its reconciler only erases rows older than five minutes, so a hidden row
   stays out of every list, search and context and is never erased. `DREAM_HISTORY_ENABLED` is
   written `false`, so a dream keeps no extra copy of what it removed.
7. **Hidden facts can be brought back.** The Nocheh Honcho routes `GET /nocheh/hidden` (newest
   hidden first) and `POST /nocheh/hidden/restore` (1 to 50 ids) list hidden facts and clear the
   mark; a restore also brings back each wall copy of a restored fact. Memory › Long-term › Facts it
   learned shows them under "Hidden facts", each with "Bring back".
8. **Forgetting still erases.** Forgetting a message walks its descendants, hidden ones included,
   and turns the hidden ones back into ordinary soft deletes so the reconciler erases them with
   the rest. Deleting a session erases its hidden rows with it.

## Consequences

- Turned on, each dream costs up to about 22 memory-model calls, for the whole memory of each
  person and for each wall a person writes in. Thinking goes through the meter, so it is priced
  and counts toward the optional monthly memory-thinking limit (ADR-0279).
- A retired fact disappears from fact lists and recall, but stays in the database, hidden, until it
  is brought back or the message it came from is forgotten.
- A whole-memory dream may retire a group fact because of a newer fact from another chat; the
  group then no longer sees the old fact. Nothing new is shown to the group.
- While a dream runs the workspace queue is busy, so memory can show as catching up.
- Checks: `services/honcho/test_setup.py`, `test_boundary.py`, `test_provenance.py`,
  `test/fact-sources.test.ts`, `test/store-native-memory.test.ts`, `test/store-fact-sources.test.ts`,
  `test/memory-engine.test.ts`.
