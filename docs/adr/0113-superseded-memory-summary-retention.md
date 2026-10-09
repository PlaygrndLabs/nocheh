# ADR-0113: Remove superseded Honcho context summaries

<status>
Accepted implementation decision. Extends
[0112](0112-spent-workflow-record-retention.md). Independent of when the
context is rebuilt ([0072](0072-validated-honcho-context-renewal.md) and the proposed
[0109](0109-standard-honcho-entity-model.md)).
</status>

<context>
Each Honcho context rebuild records the full peer representation (a
`memory_result` derived artifact of up to 2 MB, with its full text copied into
`search_text`), a bounded `memory_context` summary of up to 20,000 characters,
and a guarded copy of that summary. A rebuild follows every batch of new Honcho
work, but only the summary that a memory generation's snapshot points at is
ever read again. None of these rows were removed, so derived storage grew by a
full representation per rebuild. The project is in development, so this needs
no migration, and it does not change how Nocheh uses Honcho while ADR-0109 is
on hold.
</context>

<decision>
The daily retention worker reads the summaries that non-retired memory
generations serve from the control store. In derived storage it then removes,
in bounded transactions:

- bounded summaries that no such generation serves, unless a prepared runtime
  input still references their guarded copy, together with that guarded copy
  (source, revisions, activations and fragments);
- full representations whose bounded summary is gone or was never saved.

Only rows older than one hour are touched, so a rebuild that has not yet saved
its snapshot is kept. The derived runtime role cannot delete, so this worker
connects to the derived store as the local administrator inside the database
container. `NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS=0` turns it off with the
rest of retention.
</decision>

<consequences>
Derived storage keeps one served summary per active generation plus recent
rebuilds. Older context results disappear from advanced provenance views.
Honcho workspaces of retired guard epochs are outside this decision and still
remain until ADR-0109 replaces per-epoch workspaces. The selection relies on the
`native-context:` operation identifiers; a change to those identifiers must
update this retention.
</consequences>
