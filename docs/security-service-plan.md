# Security service implementation

Authorized 2026-09-10 under [ADR-0037](adr/0037-external-security-plugin-service.md).
The owner requested automatic progression and a commit after each verified phase.
This document tracks security work independently of pending shared-provider and
Honcho activation. Local Compose is the release target.

| Phase | Deliverable and acceptance | Status |
|---|---|---|
| SEC1 | Boundary inventory; versioned plugin/policy contract; precedence, autonomy and baseline tests | Complete |
| SEC2 | External provider/context broker and isolated turn launcher; no credential/root-profile/egress escape; failure tests | Pending |
| SEC3 | Durable configuration, bounded authority and clear decision/effect records; owner CLI/API; concurrency/revocation tests | Pending |
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
