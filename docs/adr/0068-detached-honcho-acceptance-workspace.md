# ADR-0068: Time-bound Honcho acceptance while memory is detached

Implementation and activation evidence belong in [TASK.md](../../TASK.md).

<decision>

Production Honcho acceptance uses a random, short-lived synthetic workspace issued
through the owner-authenticated local API. The workspace is bound to the current
installation and guard generation, expires after thirty minutes, and can be
closed sooner. Only the two metered chat and embedding routes may use it. Every
provider request still passes through the normal guarded preparation service and
the existing spending gateway. A closed or expired workspace, a changed guard
generation, or attached memory denies this path.

The synthetic workspace permits provider checks before the production memory
connection is verified or attached. The acceptance report must identify a closed
workspace from the current generation. That report remains an operator assertion
backed by saved provider, ingestion, retrieval, restart, failure, and budget
evidence; issuing a workspace or passing an isolated fixture is not verification.
Normal memory generations continue to require attached, verified memory and
current source provenance. Owner attachment, opted-in history, and monthly budget
activation remain separate decisions.

This extends [ADR-0033](0033-guarded-projections-and-honcho-memory.md) and
[ADR-0034](0034-explicit-embedding-environment.md) without changing their
guarding, spending, or attachment boundaries.

</decision>
