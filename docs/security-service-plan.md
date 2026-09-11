# Security service execution and acceptance

[SPECS.md](../SPECS.md) defines security, authority, and memory preservation.
[TASK.md](../TASK.md) records actual activation. ADR-0037 supplies the rationale;
[AGENTS.md](../AGENTS.md) defines the increment and integration workflow.

## Phases and acceptance

| Phase | Work and acceptance procedure |
| --- | --- |
| SEC1 | Inventory provider/context, Telegram, scheduled delivery, owner administration, detection, and transcription boundaries. Verify versioned policy/protocol contracts and baseline authority/recall behavior. |
| SEC2 | Implement external broker and isolated launcher; test denied credential, filesystem, network, hosted-tool, and opaque-context escapes, stale scopes/epochs, and broker failures. |
| SEC3 | Connect durable owner policy, bounded grants, and effect receipts through CLI/API. Test concurrency, revocation between claim/start, explicit-deny precedence, and uncertain outcomes. |
| SEC4 | Preserve full authorized memory as evidence. Compare exact requests, citations, native histories, model/reasoning settings, and context accounting; reject lossy or approval-heavy context handling. |
| SEC5 | Run adversarial and real Compose isolation/recovery checks, live recall/grounding comparison, backup/inactive-state checks, then record deliberate activation and quality limits. |

SEC1–SEC5 are verified and active locally; shared-provider and Honcho activation
remain separately gated. [Owner operations](security-service.md) contains commands
and rollback instructions. Quality measurements are finite observations, separate
from deterministic transport and authorization checks.

## Historical verification and activation evidence

The following records describe their phase checkpoints, including temporary
candidate switches and pending activation at those times. TASK.md is the current
status entry point; SPECS.md supplies the product requirements.

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
No profile was moved and no runtime route was switched during SEC2. No memory
or context limit was reduced. Native history readers support both layouts.

SEC3 verification: all 54 service checks passed with real isolated PostgreSQL
(zero skips). Coverage includes concurrent policy edits, deny-over-approval,
one grant across multiple turns, revocation between claim and start, separate
execution receipts, unchanged archive/guard/sharing behavior and secret-free
effect records. Six executor tests passed, including denied start and receipt
outage without replay. The [owner CLI/API](security-service.md) is available in
the candidate source. Graphify refreshed. Policies are shared by the broker and
trusted archive executor; effect logs distinguish reservation from execution.

SEC4 verification: four pinned-Hermes memory checks preserve full native blocks,
retrieved objects/citations, Unicode/spacing, current history and model settings;
they also verify refresh after native prompt rebuild and complete preflight token
accounting. The full pinned Python suite ran 116 checks: 114 passed, two optional
checks skipped. The previous 54 service checks cover authorized retrieval and
exact guarded revisions. Graphify refreshed. `NOCHEH_MEMORY_CONTEXT=evidence` is
a separate candidate switch; it is not silently enabled without the live quality
comparison. No classifier drops memory and no source is summarized by this layer.


SEC5 verification and activation, 2026-09-10:

* All 55 service checks passed against isolated PostgreSQL, without skips. The
  final pinned Hermes suite ran 123 checks: 121 passed and two optional checks
  skipped. Real Docker confinement ran separately and passed. Coverage includes
  hosted-tool and opaque-history rejection, revocation during streamed output,
  mandatory-denial receipts, browser mode propagation and portable native history.
  [Test record](../compatibility/results/security-service-tests.json).
* The initial recall, grounding and reasoning comparison passed 12/12 factual
  checks. In the stricter comparison, the evidence candidate passed 6/6 exact
  checks; baseline passed 5/6, with correct factual values under different JSON
  field names in one answer. Both used `gpt-5.6-sol` and the original 272,000-token
  context window. No approval was requested for context work. These small
  synthetic fixtures establish observed parity only, not universal accuracy.
  [Exact comparison](../compatibility/results/security-service-acceptance.json).
* The actual launcher passed credential rejection, supervised recall, persistent
  history, disconnect cleanup and orphan removal after restart without replay.
  Native import-time delegation/delivery ledgers now share the persistent DB;
  the native memory lock is shared across the container boundary. The acceptance
  gate caught and prevented activation with a temporary history database.
  [Launcher evidence](../compatibility/results/security-service-launcher-acceptance.json).
* Four existing profile databases were checkpointed, integrity checked, moved
  without changing their bytes and privately copied for preservation. Local
  Compose now uses `isolated` execution and `evidence` memory; the bounded tool
  executor was drained and restarted. The rebuilt images reuse the already
  installed pinned dependency images. [Activation receipt](../compatibility/results/security-service-activation.json).
* The active subscription turn passed exact saved owner-copy recall, durable
  conversation history, provider receipts and routine work without approval.
  [Active check](../compatibility/results/security-service-active.json). The
  existing secret detector masked a harmless synthetic colour; that observation
  is [retained separately](../compatibility/results/security-service-active-detector-observation.json).
  The owner-edit check isolates the transport guarantee from detector quality.

No new layer summarizes or deletes memory, changes reasoning effort, or reduces
configured native memory/context limits. Existing Honcho attachment and shared
provider cutover remain pending under their own plans. Trusted perception,
selected-group conversation and scheduled delivery retain their existing gates;
this service does not claim to isolate the trusted launcher or host. Guard off
never disables audience, tool authority, hosted-tool or opaque-context boundaries.
Graphify was refreshed using AST extraction only. Owner configuration, logs and
rollback instructions are in [the service guide](security-service.md).
