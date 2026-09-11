# ADR-0018: Hermes, an owned archive, and a subscription-based rebuild

## Status

Accepted, 2026-09-06. Supersedes the legacy implementation and sequencing in
ADRs 0001–0006 and 0008–0017 where they conflict with this decision. Retains the
personal-brain mission in ADR-0007 and deterministic local masking from ADR-0010.
Historical ADRs remain unchanged.

## Decision

Rebuild in this repository, preserving the existing implementation at `9dd0b58`
on `codex/legacy-nocheh`; implement on `codex/hermes-rebuild`, then merge to `main`
after acceptance. Existing persisted data is disposable; no migration is required.

Use Hermes's native Telegram adapter, agent, tools, profiles, and built-in memory.
Nocheh owns TypeScript services for capture/import, PostgreSQL original-data storage,
file preservation, scoped retrieval, export/replay, and optional guarding. Keep
Python integration thin and allow only a minimal pinned Hermes compatibility patch.

Store original messages and observed events before downstream processing. Preserve
retrievable media bytes. Derived text and model-generated records carry provenance
and remain separate from original content. Optional guarded copies are versioned
cache records in the same Nocheh database. Hermes state is replaceable runtime state.

Guard modes are `off`, `on`, and `auto` (default), evaluated for the actual model
destination on every attempt. Trusted ChatGPT may receive originals. A trusted
detector returns literal substrings and local code masks them without rewriting.
Required guarding fails closed, covering complete history, memory, tool results,
auxiliary calls, and route changes. Raw media reaches only explicitly trusted
perception destinations; derived text follows normal guarding.

Production uses ChatGPT subscription authentication, with no local models or paid
model-provider API keys. Transcription is required. Test the existing `codex-asr`
bridge first; it is unofficial and must work for the account and target VPS.
Do not introduce a paid or local fallback when compatibility fails.

Groups may receive proactive conversation and only group-local memory. The owner's
private DM can search across the archive. Other external actions require owner
approval. No auto-trading, and no group-member administrative authority.

Honcho is an isolated optional experiment, not production memory. The temporary
API key is restricted to the comparison, with a $5 maximum metered budget.
Reasoning via CLIProxyAPI does not remove Honcho's embedding dependency.

## Consequences and evidence gates

- Each completed phase is tested and committed before automatic progression.
- Prove chat, literal detection, audio transcription, credential refresh, failure
  behavior, and VPS compatibility before replacing the legacy runtime.
- Local/mocked results are not live account/VPS evidence.
- Durable spool and retry protect captured events across database outages.
  Historical imports/replay do not send replies; ambiguous sends need reconciliation.
- The custom graph, custom extraction pipeline, and old dashboard are deferred.
- Preserve portable source data so future Honcho, graph, or other memory adoption
  can replay it without recollecting conversations.

The full acceptance checklist is in [the rebuild plan](../rebuild-plan.md).

## References

- [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways)
- [codex-asr](https://github.com/Wangnov/codex-asr)
- [Honcho configuration](https://honcho.dev/docs/v3/contributing/configuration)
