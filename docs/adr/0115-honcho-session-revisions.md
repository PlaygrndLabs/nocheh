# ADR-0115: Versioned Honcho sessions with targeted rebuilds and live reply context

<status>
Accepted implementation of [ADR-0109](0109-standard-honcho-entity-model.md)
steps H1–H4, authorized by the owner on 2026-10-09. Replaces the context
snapshot table of ADR-0044, ADR-0072 and
[ADR-0114](0114-event-driven-honcho-context.md). The fresh start (H5) and live
acceptance (H6) are not part of this decision.
</status>

<context>
Every guard-epoch advance (a reaction, schedule edit, publication, learned-rule
replacement or owner command) retired the ready Honcho workspace of each
audience and re-ingested every archived source into an empty copy. Hermes'
`nocheh_memory_recall` then searched only that empty copy, so recall reported
nothing for minutes or failed outright. ADR-0109 adopts Honcho's documented
model; this record settles how Nocheh writes, reads and corrects it.
</context>

<decision>

- **Workspace.** One Honcho workspace per installation generation, recorded as a
  single `memory_generations` row with audience `installation`. Guard epochs
  never retire it; an installation reset or a new mapping version does.
- **Peers.** People and projects keep their stable entity peers. The assistant
  is the peer `nocheh_assistant`, created with `observe_me: false`; its
  delivered messages are written but never observed. Sources without a resolved
  speaker keep their evidence peer.
- **Sessions.** `memory_sessions` maps a stable key to a Honcho session ID that
  includes a revision. Keys are the conversation (chat, group, topic), the
  subject evidence of each conversation, and each learned interpretation. A
  session belongs to exactly one audience: `owner` for owner-private chats, the
  group or topic space otherwise. Writing another audience's evidence into an
  existing session is refused.
- **Writes.** Each source is written once, to its own audience. The written text
  holds only that source's own observations, and its receipt depends only on
  the source's guard revision and its own derivative selections, so later rules,
  neighbouring messages and reactions never rewrite it. A receipt's logical
  identity does not depend on the session revision.
- **Validity.** A written receipt stays valid while its evidence is learnable
  and readable by its audience, its audience is unchanged, its dependencies or
  interpretation revision are current, its speaker and subject entities are
  active, and the guard mode matches. A later reaction change adds evidence; it
  does not retract the earlier reaction.
- **Corrections.** When a receipt becomes invalid, or a source or
  interpretation is written again with different content, only the sessions
  that held it are rebuilt: the session revision advances, its receipts retire,
  still-valid writes are carried into the new revision without new preparation,
  changed sources are re-ingested, and the old session is deleted from Honcho.
  The deletion first removes conclusions outside that session derived from it
  (found through document ancestry and message links by Nocheh's Honcho
  plugin), then deletes the session.
- **Epochs.** After a guard epoch, a bounded sweep checks written receipts and
  rebuilds only sessions holding invalid ones, then writes interpretations that
  never reached Honcho. It never re-ingests the archive. Reaction changes do not
  start this sweep. Native-note review asks Honcho to write only sources it has
  not written.
- **Reads.** A reply reads Honcho's session context for its own conversation on
  arrival, with the speaker as `peer_target` when that peer has written
  evidence. Owner reads span the workspace; group and topic reads add
  `limit_to_session`, so they never receive a person's whole representation.
  An owner chat without a session falls back to the speaker's representation.
  The guarded result is keyed by its content, so identical Honcho output reuses
  its guarded copy. Recall and contextual learning for groups and topics pass a
  `session_id` allowlist of that audience's sessions and fail closed when it is
  empty.
- **Prefetch.** When Honcho finishes the workspace's work, each conversation
  with new writes gets one `context:` prefetch for its latest speaker. Nothing
  refreshes on a timer. Learning for a source waits only for that source's
  sessions to finish in Honcho.
- **Egress.** Honcho's derivation requests that quote already-written receipts
  are prepared without re-detecting those exact texts in a later epoch.

</decision>

<consequences>
- Reactions, rules and other unrelated epochs no longer empty Honcho memory, so
  recall keeps working through them.
- A correction re-derives the whole affected session. Large group sessions cost
  more to correct than to read; Honcho cannot delete single messages.
- Peer cards are workspace-wide and carry no session provenance. They are read
  only by owner turns, and a correction cannot remove a card entry directly.
- Owner-approved passages written in one epoch are preserved in reply context
  only while that epoch lasts; afterwards Honcho output is checked by the
  detector again, which fails safe.
- Earlier per-audience workspaces are retired locally but stay in Honcho until
  the owner-gated fresh start (H5) deletes them.
</consequences>
