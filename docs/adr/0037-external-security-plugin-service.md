# ADR-0037: External security plugin service

Status: Accepted by the owner, 2026-09-10. Activation is gated separately.

Nocheh will adopt an external security service and runtime adapter, informed by
[the Muse assessment](../research/muse-security-assessment.md). A process-level
HTTP patch is useful compatibility glue but cannot enforce filesystem or network
isolation. The model must not own the credentials or policy that constrain it.

The TypeScript service owns a versioned protocol, policy evaluation, brokered
provider requests and auditable effect decisions. Durable records stay in Nocheh's
existing PostgreSQL database. Hermes remains replaceable and owns native memory.
Only a trusted launcher may provision isolated turns. Agent containers receive a
single profile, scoped access to archived sources, and an internal broker route;
they receive no provider refresh store, master service token or Docker socket.

Preserve original data, exact guarded owner edits, authorized retrieval, native
history, model choice and reasoning settings. Memories are evidence, never policy
or approval. Guard on/off continues to select representation under ADR-0033; it
does not turn off audience or effect authorization. No new lossy memory summaries.

Routine authorized context work needs no confirmation. External effects require
existing owner approval or a matching bounded, expiring, revocable grant. Explicit
denies and mandatory boundaries take precedence. Policies and grants are owner
configuration, with optimistic revisions and a preview. Agent-supplied policy
claims have no authority. Successful routine activity is quiet by default.

Logs distinguish a proposal, decision, execution start and observed result. An
allow decision is not an execution receipt. Logs carry safe identities, policy
revision and reason, not prompts, credentials, raw URLs or memory contents.
Source evidence remains inspectable through existing owner archive access.
Unknown outcomes remain ambiguous and are not automatically repeated.

Replacement or outage must not create an unguarded fallback. Quality and autonomy
regressions block activation. No claim of identical model accuracy follows from
passing a finite test suite. Local Compose is the acceptance target; existing
provider/Honcho activation requirements remain separate.

Implement and commit each phase of [the security plan](../security-service-plan.md)
and continue automatically. Historical decisions remain unchanged.
