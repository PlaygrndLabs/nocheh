# ADR-0109: Use Honcho through its documented entity model

<status>
Proposed by owner direction on 2026-10-09; the owner chose plan-only review
before implementation. When accepted, this supersedes the per-generation
workspace and timer-refreshed context parts of ADR-0033, ADR-0044, ADR-0056
and ADR-0072. Audience isolation from ADR-0030 is retained.
</status>

<context>
Nocheh creates one Honcho workspace per memory generation: a digest of
installation generation, guard epoch and audience
(`src/stores/native-memory.ts:122`). Every audience (owner, each group, each
topic) has its own workspace, and every guard-epoch advance (reaction change,
schedule edit, publication, learned-rule replacement) retires all generations
and re-requests preparation and Honcho ingestion for every archived source
(`src/stores/workflow-operations.ts:76-84`). Old workspaces are never deleted.

Reply turns read a cached snapshot of Honcho peer representations from
`memory_context_snapshots`. It is usable for five minutes, and a
`context:<generation>` workflow refreshes it every 120 seconds forever
(`workflow-operations.ts:190`), storing each wait in Inngest history. The agent
has no Honcho peer, and Hermes' own Honcho memory provider is disabled.

Recall failures observed in operation came from this design: a ready Honcho
generation was revoked by an unrelated epoch advance and the retry landed on a
generation with no ready context. The design is also the main source of
unbounded workflow and Honcho storage growth.

Honcho's documentation recommends one workspace per application, split only at
hard tenant, compliance or environment boundaries; a stable peer per real-world
entity, including agents; sessions per conversation, channel, project or
import; and application-enforced access, because "scopes are not access
control". It describes queue status as observability, not synchronization.
Hermes' Honcho plugin prefetches context after each turn by turn cadence, not
by timer. Neither recommends rebuilding workspaces when permissions change.
</context>

<decision>
- One Honcho workspace per installation for production memory; isolated test
  fixtures use their own workspace.
- Every entity is a peer with a stable Nocheh-derived ID: the owner, each
  person, each confirmed project, and the assistant. The assistant peer is not
  observed (`observe_me: false`) but its messages are saved.
- Sessions bound conversations: each Telegram private chat, group, topic,
  import, and project-evidence stream. Observation is directional.
- Audience isolation is enforced by Nocheh at query time: a turn may query only
  the sessions and peers its audience is authorized for (`session`/`sessions`
  filters, `limit_to_session`, `peer_target`). Owner-private evidence is never
  written into a session that a group or topic audience may query.
- Guard epochs, policy changes and learned-rule replacements do not create new
  workspaces or re-ingest every source. Corrections and retractions delete the
  affected Honcho session or conclusions and re-add the corrected evidence.
- Reply context uses Honcho's documented reads: `session.context` for the
  current conversation with the speaker as `peer_target`, and `peer.chat` only
  for specific recall. Nocheh prefetches the next context after each completed
  turn and when Honcho finishes new work for that session, then checks
  freshness when a message arrives. There is no timer refresh loop.
- Hermes reaches Honcho only through Nocheh's memory tools; it receives no
  Honcho credentials. The same Nocheh memory interface serves Honcho without
  Hermes later and keeps memory swappable.
</decision>

<consequences>
- Removes the epoch fan-out, per-epoch workspaces and the 120-second refresh
  workflow, which are the main unbounded storage sources.
- Recall no longer loses ready memory because of unrelated reactions or rules.
- Honcho cannot delete peers or individual messages, and session deletion
  leaves workspace-level conclusions; targeted correction must delete those
  conclusions explicitly. Session layout must keep owner-private material out of
  shared sessions because deletion is coarse.
- Requires a one-time re-ingest into the new workspace, then deletion of the
  old generation workspaces, under the existing attachment and acceptance gates.
- Specifications that name per-audience workspaces and generations need
  revision when this ADR is accepted. See the
  [migration plan](../honcho-standard-memory-plan.md).
</consequences>
