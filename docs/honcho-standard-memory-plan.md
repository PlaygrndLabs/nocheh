<execution_plan>

# Standard Honcho entity model migration

<authority>

Plan only, requested by the owner on 2026-10-09 for review before any code
change. Requirements live in [SPECS.md](../SPECS.md), the proposed decision in
[ADR-0109](adr/0109-standard-honcho-entity-model.md), and status in
[TASK.md](../TASK.md). Implementation starts only after the owner accepts
ADR-0109. Honcho attachment, re-ingestion and deletion of old workspaces keep
their existing owner gates.

</authority>

<target_model>

| Honcho concept | Nocheh mapping |
| --- | --- |
| Workspace | One per installation (`nocheh`); synthetic fixtures use their own |
| Peer | Owner, each person, each confirmed project, the assistant (`observe_me: false`) |
| Session | Each private chat, group, topic, import batch stream, and project-evidence stream |
| Message | Guarded source chunk with Nocheh receipt metadata, authored by its actual speaker |
| Reply context | `session.context(peer_target=speaker, tokens=N)` prefetched after each turn and when Honcho finishes new work |
| Specific recall | `peer.chat` within the audience's authorized sessions |
| Access control | Nocheh resolves the audience's authorized sessions and peers before every read |
| Correction | Delete affected session or conclusions, re-add corrected evidence |

</target_model>

<sequence>

| Step | Work | Acceptance before completion |
| --- | --- | --- |
| H0 — Decide | Owner reviews ADR-0109; resolve open questions below; revise the affected specs (per-audience workspaces, generations, readiness) | Owner acceptance recorded |
| H1 — Mapping | New mapping version: installation workspace, entity peers including the assistant, session layout, audience-to-session authorization table | Unit checks for mapping, private/group separation, stable IDs |
| H2 — Writes | Ingestion writes into the new mapping with existing receipts and uncertain-write reconciliation; no per-epoch rebuild | Receipt, retry and uncertain-write checks; no workspace creation on epoch advance |
| H3 — Reads | Replace snapshot table and 120-second `context:` workflow with turn-driven prefetch and arrival-time freshness check; audience-filtered `context`/`chat` | Group turn cannot read owner-private sessions; first-turn bounded wait; no timer workflow registered |
| H4 — Corrections | Retraction and edit paths delete affected sessions or conclusions and re-add corrected evidence | Retired fact absent from context and chat after correction |
| H5 — Migration | One-time re-ingest of consented sources into the new workspace; then delete retired generation workspaces | Isolated fixture rehearsal, then owner-authorized operating run; storage measured before and after |
| H6 — Acceptance | Same-topic recall, private recall, group isolation and timing checks | Recorded in the acceptance register; failures stay failed |

</sequence>

<open_questions>

- Projects as peers and as session scopes: confirm both, or peers only.
- Whether groups and topics also become entities (peers) or stay sessions only.
- Hermes integration: keep Nocheh's memory tools as the only route (proposed),
  or later adopt Hermes' Honcho plugin behind a Nocheh-enforced proxy.

</open_questions>

</execution_plan>
