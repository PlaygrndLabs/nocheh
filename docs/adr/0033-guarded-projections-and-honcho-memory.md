# ADR-0033: Prepare editable guarded projections and use Honcho as primary memory

Accepted by the owner, 2026-09-09. Implementation status is in TASK.md.

Supersedes prior three-state and request-time guarding decisions. Guarding has
only on/off, defaults on, and legacy auto migrates to on. Originals and file bytes
remain unchanged in Nocheh's archive. Separate, durable guarded revisions are
prepared at ingestion and reused. The dashboard displays both; only guarded
projections are editable. Automatic copies publish immediately. An owner save is
authoritative, retains history, and cannot be re-masked or overwritten by a job.

On selects guarded data for Hermes, Honcho, embeddings and agent tools, including
trusted reasoning routes. Off selects originals with the same audience checks.
New content is prepared once; final request checks still enforce current revision,
audience and destination on every attempt. Unknown content fails closed. Trusted
detector and media preparation calls necessarily receive original inputs. Guarding
is neither archive encryption nor a guarantee of perfect secret detection.

Edits and representation changes retire affected memory generations before reuse.
Rebuilds use current authorized sources; original and guarded memory never mix.
Imported learning remains explicit opt-in, independent of guard preparation.

Honcho is the primary long-term memory, using CLIProxyAPI for subscription reasoning.
Hermes retains its native MEMORY.md/USER.md and sessions. Nocheh is the sole Honcho
ingestion writer, with durable source/revision receipts and uncertain-write
reconciliation. Attachment, detachment and history ingestion are reversible and
explicit. Outages retain current context, notes and archive search where available.

The owner explicitly authorizes dedicated paid embeddings: a $5 total pilot cap,
then $5/month, with hard admission limits. This is the sole production exception
to the no-paid-model-key rule; reasoning stays on subscription. Never reuse unrelated
credentials. Missing credentials and live evidence remain pending, not passed.

Implement and verify the seven phases in docs/guarded-memory-plan.md, committing
each separately and continuing automatically. Local Compose is the target;
existing release gates and the prohibition on premature main merge remain.
