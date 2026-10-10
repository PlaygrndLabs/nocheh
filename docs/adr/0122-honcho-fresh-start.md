# ADR-0122: Honcho fresh start deletes earlier Nocheh workspaces

<status>
Accepted implementation of step H5 of
[ADR-0109](0109-standard-honcho-entity-model.md), started by the owner on
2026-10-10. Builds on [ADR-0115](0115-honcho-session-revisions.md).
</status>

<context>
ADR-0109 records the owner's decision that existing Honcho memory starts fresh:
the new workspace learns from new messages only, and the old per-audience,
per-epoch workspaces are deleted. Nocheh records every workspace it created as a
`memory_generations` row. Honcho deletes a workspace only after its sessions are
deleted, and both deletions finish in Honcho's background queue.
</context>

<decision>

- `./bin/nocheh memory honcho fresh-start` (owner API
  `POST /v1/memory/honcho/fresh-start`, revision-checked and idempotent by
  operation ID) advances the connection's workspace revision, sets the
  attachment time to now with history ingestion off, retires every recorded
  workspace, and queues one `retire:<workspace>` job per recorded workspace.
- The installation workspace ID includes the workspace revision after the first
  revision, so the next write opens a new, empty workspace. Reads and writes
  check the revision, so nothing reaches an earlier workspace again.
- A `retire:` job lists the workspace's active Honcho sessions, deletes them,
  then deletes the workspace (an absent workspace counts as deleted), and then
  removes Nocheh's receipts, sessions, session deletions and generation row for
  it. Progress is reported under `workspace_deletions` in memory status.
- Only workspaces Nocheh recorded are deleted. Any other workspace in Honcho,
  including live-acceptance workspaces, is left alone.
- A source received before the fresh start is not written again unless the
  owner consented to learning it explicitly; earlier receipts in retired
  workspaces no longer count as already learned.

</decision>

<consequences>
- Honcho memory is empty until new messages are learned; originals stay in the
  archive, so an owner-approved re-ingest remains possible later.
- Honcho storage shrinks only after its background queue finishes the queued
  deletions.
- Jobs that still refer to deleted receipts or retired workspaces are skipped as
  superseded.
</consequences>
