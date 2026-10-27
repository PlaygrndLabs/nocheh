# ADR-0181: Changing the memory search model rebuilds Honcho memory

<status>
Accepted on 2026-10-27 for the owner's answer "but we should able do it" to
Settings › Models refusing `text-embedding-3-large` once Honcho memory held
`text-embedding-3-small` vectors. Builds on
[ADR-0153](0153-owner-reruns-and-replaces-honcho-memory.md) and
[ADR-0122](0122-honcho-fresh-start.md).
</status>

<context>
Honcho stores every vector of long-term memory with one embedding model, and
the provider gateway's ledger records that model; a vector from another model
cannot be compared with them. Settings refused another model once the ledger
had one, and the dashboard greyed the other model out, so the owner could not
change a setting from the dashboard. Only Honcho stores embeddings: the
archive, derived data and Hermes native notes use text search.
</context>

<decision>

- Every reviewed memory search model stays selectable. When Honcho memory
  already holds vectors from another model, Save asks the owner to confirm
  that long-term memory is rebuilt, with how many saved messages it would learn
  again and that this costs money and counts toward the month's memory limits.
- A confirmed change is saved with `rebuild_memory` (`./bin/nocheh config set
  NOCHEH_EMBEDDING_MODEL MODEL --rebuild-memory`), which records the model and a
  fixed operation ID in `admin/memory-rebuild.json`. Without it the change is
  refused as before. Choosing the stored model again drops the record.
- Apply restarts Honcho and its gateway with the new model, then moves the
  gateway ledger's embedding route to the new model, keeping every spending
  record, and runs the ADR-0153 replacement from the archive with the recorded
  operation ID: a new workspace learns every allowed saved message again, and
  the old workspaces leave Honcho with their vectors.
- If Honcho does not restart or the replacement does not start, Apply leaves
  the settings waiting to apply and the dashboard offers Try again; the fixed
  operation ID replaces memory once even when an answer was lost.
- No migration or conversion of the old vectors exists; they are rebuilt.

</decision>

<consequences>
- Until the archive is learned again, replies read less long-term memory, as
  after any replacement.
- During the seconds between the restart and the replacement, the gateway
  refuses embeddings for the old workspace; that workspace is deleted anyway.
- The full tester switches its fixture from the small to the large model and
  checks that the old workspace is deleted, imported messages are learned again
  with new vectors, and new learning has no errors.
</consequences>
