# Security service implementation

Authorized 2026-09-10 under [ADR-0037](adr/0037-external-security-plugin-service.md).
The owner requested automatic progression and a commit after each verified phase.
This document tracks security work independently of pending shared-provider and
Honcho activation. Local Compose is the release target.

| Phase | Deliverable and acceptance | Status |
|---|---|---|
| SEC1 | Boundary inventory; versioned plugin/policy contract; precedence, autonomy and baseline tests | Complete |
| SEC2 | External provider/context broker and isolated turn launcher; no credential/root-profile/egress escape; failure tests | Complete (candidate; activation pending SEC5) |
| SEC3 | Durable configuration, bounded authority and clear decision/effect records; owner CLI/API; concurrency/revocation tests | Complete |
| SEC4 | Memory evidence separated from instruction authority without truncation; exact context and retrieval parity checks | Pending |
| SEC5 | Adversarial and local Compose acceptance, lifecycle/failure evidence and quality/autonomy gate; documented activation status | Pending |

Each phase records its checks here before committing. Tests that skip for absent
services do not count as acceptance. Live model quality is reported separately
from deterministic transport/recall preservation. Retain current runtime routing
until the candidate passes its applicable acceptance checks.

## Boundary inventory and baseline

* `turn_process.py` currently spawns a child with a provider token, native profile
  and shared container filesystem. The child lacks native shell tools, but that
  is not operating-system isolation. Replace this managed path with a trusted
  isolated launcher and scoped broker credential.
* `request_boundary.py` guards HTTPX requests; `prepared-context.ts` preserves
  durable projections. Keep their exact preparation semantics; enforce provider
  forwarding externally so bypassing the patch cannot bypass preparation.
* `access.ts` checks signed turn identity, sharing revision and guard epoch.
  Reuse it at the broker. Relay only known scoped archive endpoints, never admin
  routes. Private recall must retain its existing authorized source coverage.
* `controlled-actions.ts` already binds exact arguments, bounded grants and
  durable execution receipts. Extend it instead of creating a second executor.
  `scripts/tool_execution.py` remains responsible for restricted public HTTPS
  and offline/shell containers. A proposal's URL is not permission to send it.
* Telegram delivery, scheduled delivery, owner administration, trusted secret
  detection and trusted transcription are separate paths. Their existing gates
  remain mandatory and must be listed in final coverage, not implied covered by
  a managed-turn proxy. No claim to isolate a compromised trusted host or Docker.
* Native memory currently enters the system prompt. Move complete evidence to
  a lower-trust context message while preserving the text, session retrieval,
  selected model and context limits. Measure actual requests and recall.

Acceptance baseline: exact prepared text and owner edits; all authorized source
references; native notes/history; model and reasoning configuration; no prompts
for routine context; one bounded approval usable across matching turns; no
automatic replay after an uncertain effect. Missing live providers remain pending.

SEC1 verification: TypeScript build, four contract behavior tests and nine existing
Hermes controlled-tool/turn-process baseline tests passed without skips. Graphify
refreshed using AST extraction only. No runtime activation in this phase.

SEC2 verification: six TypeScript contract/broker checks passed against an isolated
PostgreSQL database, including exact request preservation, route denial, stale
epochs and guard outage. Four Python security checks passed including a real
Docker container with denied external DNS/network, absent credentials/socket,
read-only configuration and a durable exact native-memory write. The full pinned
Hermes suite ran 111 checks: 109 passed, two optional checks skipped (the Docker
fixture was run separately). Fifteen host baseline/configuration checks passed.
Graphify refreshed. Fresh image build and coupled live activation belong to SEC5.

The launcher is explicitly trusted infrastructure with Docker authority and a
read-only profile inventory. Only data directories are writable by turns; an
existing `state.db` must be moved offline into `native-state` before activation.
No current profile was moved and no runtime route was switched in SEC2. No memory
or context limit was reduced. Native history readers support both layouts.

SEC3 verification: all 54 service checks passed with real isolated PostgreSQL
(zero skips). Coverage includes concurrent policy edits, deny-over-approval,
one grant across multiple turns, revocation between claim and start, separate
execution receipts, unchanged archive/guard/sharing behavior and secret-free
effect records. Six executor tests passed, including denied start and receipt
outage without replay. The [owner CLI/API](security-service.md) is available in
the candidate source. Graphify refreshed. Policies are shared by the broker and
trusted archive executor; effect logs distinguish reservation from execution.
