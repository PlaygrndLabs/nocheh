# ADR-0229: Long-term memory sits behind a memory socket

<status>
Accepted on 2026-11-10, after the owner said: "the main things in nocheh should
be data and hermes and honcho should be replace able with other things like
claude code or mem0", and then approved the build plan that makes the brain and
the memory swappable while the data stays in Nocheh. Keeps
[ADR-0109](0109-standard-honcho-entity-model.md)'s entity model,
[ADR-0115](0115-honcho-session-revisions.md)'s sessions and receipts, and
[ADR-0225](0225-member-safety-rules.md)'s rule that no peer card is read.
</status>

<context>
- Nocheh's storage service called Honcho's HTTP API from many places:
  feeding writes in, start-of-turn context, recall, search, queue health,
  retries, provenance, and session and workspace deletion. Honcho's routes,
  payloads and error codes were mixed into the code that keeps receipts,
  sessions, sharing rules and deletions.
- Swapping Honcho for another engine, such as mem0, meant editing all of it.
- Brains never call Honcho. They ask Nocheh, which checks the audience and
  sharing rules first. That must stay true for any engine.
</context>

<decision>
- `src/memory/engine.ts` defines `MemoryEngine`, the memory socket. Words:
  a space is the installation's store in the engine, a session is one
  conversation or evidence stream, a participant is a person, project or the
  assistant, a fact is something the engine learned and can name, and a
  receipt is Nocheh's id for one write.
- The socket has five groups of calls. Feed in: `openSpace`, `addParticipant`
  with a role (`writer`, `subject` or `silent`), `openSession`, `findWrites` by
  receipt, and `write`. Progress: `busy`, `failing`, and the optional
  `failedLearning` and `retryFailedLearning`. Read: `context`, `profile`,
  `ask` and `search`, each limited to a list of sessions, or the whole space
  for the owner. Corrections and deletions: `forgetSession` and `forgetSpace`,
  one bounded step per call. Evidence: the optional `trace`.
- An engine states the longest question it takes (`questionLimits`, in
  characters and UTF-8 bytes), and `ask` can require an answer in a JSON
  format. Learning fits its question within those limits and asks for its
  result format. Each fact a trace returns says whether it cites the writes it
  came from.
- Nocheh keeps everything else: receipts, sessions, guarding, audiences,
  sharing rules, corrections, deletion bookkeeping and workflow retries. An
  engine only stores what Nocheh feeds it, learns from it and answers reads.
- Every engine reports failures with the same codes:
  `memory_engine_unavailable` (no answer, a write may have landed),
  `memory_engine_rejected` (an error answer, nothing was written),
  `memory_engine_invalid_response` and `memory_engine_unsupported`. Nocheh's
  retry and reconcile rules act on these codes only.
- `src/memory/honcho.ts` is the only Honcho engine code. `src/memory/engines.ts`
  is the one place that chooses the engine. Honcho is the only engine today.
- Each engine names a `protocol`. Space and session ids derive from it, so a
  different engine or mapping opens a new, empty space and never reads an older
  one. The owner then chooses whether it learns the archive again.
- The owner API and dashboard routes move from `/v1/memory/honcho/*` to
  `/v1/memory/longterm/*`, the turn routes to `/v1/memory/longterm/context`,
  `/recall` and `/search`, and the admin command to `memory longterm`. Source
  labels read `nocheh:memory:<id>`. The status reports `engine` with its id,
  name and capabilities. The dashboard shows "Engine: Honcho" on the
  long-term memory card, and shows the browse card only when the engine can be
  inspected.
- Stored names stay as they are, because renaming them would break a running
  installation: the `honcho` workflow family and its job keys, the
  `honcho-entity-v1` and `honcho-contextual-learning-v1` protocols, and the
  Honcho live-acceptance codes. Honcho's own service controls (its spending
  limit, service status and read-only browser) stay Honcho-specific.
</decision>

<consequences>
- A new engine is one file that implements `MemoryEngine`, plus one line in
  `engines.ts`. An engine without provenance leaves out `trace`; recall then
  reports `evidence_unsupported` instead of evidence.
- Brains still reach memory only through Nocheh's routes and tools, so changing
  the engine changes nothing for a brain.
- The older `src/honcho.ts` layer stays for its tests and legacy schema until
  it is removed.
</consequences>
