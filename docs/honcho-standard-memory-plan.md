<execution_plan>

# Standard Honcho entity model migration

<authority>

Requested by the owner on 2026-10-09. Requirements live in
[SPECS.md](../SPECS.md), the decision in
[ADR-0109](adr/0109-standard-honcho-entity-model.md) and its implementation in
[ADR-0115](adr/0115-honcho-session-revisions.md), and status in
[TASK.md](../TASK.md). The owner accepted ADR-0109 and authorized H1 to H4;
those steps are implemented in source and nothing is deployed. Honcho
attachment, re-ingestion, deletion of old workspaces (H5) and live acceptance
(H6) keep their existing owner gates.

</authority>

<target_model>

| Honcho concept | Nocheh mapping |
| --- | --- |
| Workspace | One per installation (`nocheh`); synthetic fixtures use their own |
| Peer | Owner, each person, each confirmed project (facts added as conclusions), the assistant (`observe_me: false`) |
| Session | Each private chat, group, topic, import batch stream, and each project |
| Message | Guarded source chunk with Nocheh receipt metadata, authored by its actual speaker |
| Reply context | `session.context(peer_target=speaker, tokens=N)` prefetched after each turn and when Honcho finishes new work |
| Specific recall | `peer.chat` within the audience's authorized sessions |
| Access control | Owner turns read the whole workspace; group and topic turns read their own session plus owner-approved shared facts |
| Correction | Delete affected session or conclusions, re-add corrected evidence |

</target_model>

<sequence>

| Step | Work | Acceptance before completion |
| --- | --- | --- |
| H0 — Decide | Owner reviews ADR-0109; resolve open questions below; revise the affected specs (per-audience workspaces, generations, readiness) | Owner acceptance recorded |
| H1 — Mapping | New mapping version: installation workspace, entity peers including the assistant, session layout, audience-to-session authorization table | Unit checks for mapping, private/group separation, stable IDs |
| H2 — Writes | Ingestion writes into the new mapping with existing receipts and uncertain-write reconciliation; no per-epoch rebuild | Receipt, retry and uncertain-write checks; no workspace creation on epoch advance |
| H3 — Reads | Replace the snapshot table and its one-shot `context:` rebuild ([ADR-0114](adr/0114-event-driven-honcho-context.md) already removed the timer) with turn-driven prefetch and arrival-time freshness check; audience-filtered `context`/`chat` | Group turn cannot read owner-private sessions; first-turn bounded wait; no timer workflow registered |
| H4 — Corrections | Retraction and edit paths delete affected sessions or conclusions and re-add corrected evidence | Retired fact absent from context and chat after correction |
| H5 — Fresh start | Attach the new workspace for new messages only; delete the old generation workspaces and their Nocheh generation records | Isolated fixture rehearsal, then owner-authorized operating run; storage measured before and after |
| H6 — Acceptance | Same-topic recall, private recall, group isolation and timing checks | Recorded in the acceptance register; failures stay failed |

</sequence>

<open_questions>

- Groups and topics stay sessions only unless the owner asks for them as entities.
- Hermes integration: keep Nocheh's memory tools as the only route (proposed),
  or later adopt Hermes' Honcho plugin behind a Nocheh-enforced proxy.

Decided by the owner on 2026-10-09: projects are a peer plus a session; group
and topic turns recall their own chat plus approved shared facts; existing
Honcho memory gets a fresh start with old workspaces deleted; ADR-0109 is
accepted and H1 to H4 are authorized.

</open_questions>

<implementation_status>

H1 to H4 are implemented in source as described in
[ADR-0115](adr/0115-honcho-session-revisions.md). Sessions are versioned so a
correction can delete a whole Honcho session and re-add its still-valid writes
under the next revision; Nocheh's Honcho plugin lists the conclusions derived
from a session so they are deleted first. Reply context is read live from the
conversation session on arrival and prefetched when Honcho finishes the
workspace's work, rather than after each turn. The owner started H5 and H6 on
2026-10-10. H5's fresh-start command and workspace deletion
([ADR-0122](adr/0122-honcho-fresh-start.md)) pass the fixture rehearsal; the
operating run and H6 are pending.

</implementation_status>

</execution_plan>
