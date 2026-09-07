# ADR-0028: Native learning and configurable space privacy

Accepted 2026-09-07. Supersedes the fixed group-only memory rule in ADR-0021.
Hermes performs reasoning, native memory curation and review. Nocheh owns archived
evidence, audience policy and durable delivery of evidence to the runtime adapter.

The owner private assistant can recall across all registered profiles and sources.
Groups and topics use isolated, approved (default), or explicitly enabled filtered
sharing. Topics inherit group preferences but have distinct local context. Approved
shares are exact content revisions; original sources remain private unless separately
authorized. Filtered sharing exposes only derived, audience-reviewed material to the
responder. Semantic privacy filtering is fallible and separate from provider guarding.

All policies and grants live in PostgreSQL. A global policy revision invalidates old
capabilities and group memory contexts. Native state remains in Hermes profiles;
historical mixed-topic notes are retained for the owner, never copied into new topics.
Revocation cannot withdraw information already delivered to Telegram.

Live conversations may drive native private review. Imported content is searchable
without learning; an unchecked import-step option records explicit approval to queue
Hermes review after successful ingestion. Retries preserve this decision. Background
review has no external-action tools and preserves source/inference provenance.

Implementation and acceptance are tracked in docs/space-memory-plan.md. Each phase
has its own verified commit. Work uses an isolated worktree branched from the active
rebuild; the concurrent runtime-platform work remains independently owned.
