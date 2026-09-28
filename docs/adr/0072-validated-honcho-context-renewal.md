# 0072 — Validate unchanged Honcho context before recomputing

Status: Accepted

## Context

ADR-0044 schedules a protected context refresh every two minutes and limits usable
snapshots to five minutes. The pinned Honcho representation endpoint can issue
embedding requests even when Nocheh has added no source work. Repeated refreshes
therefore consume the durable embedding cap without changing the context.

## Decision

Keep the two-minute workflow and five-minute usability limit. For a ready
generation whose saved snapshot followed its last ready transition, check the
Honcho queue and current generation revision. An empty queue and unchanged
revision validate the same snapshot for another interval without requesting a
representation. While new work builds, the previously ready snapshot may be
renewed for bounded use, with synchronization visible. A newly ready revision
requires a new representation. Context checkpoints include the work revision,
so recovery cannot reuse an older revision's result.

Guard and audience checks still apply on each read. A changed or retired
generation cannot renew its old snapshot. Failed queue checks do not validate
the cache; the ordinary five-minute limit then makes memory limited until a
successful refresh.

## Consequences

This supersedes ADR-0044's unconditional representation request on each scheduled
refresh, while retaining its schedule, freshness limit, and bounded context.
The operating installation still needs live evidence that this reduces repeated
embedding attempts and preserves current reaction meaning and recall.
