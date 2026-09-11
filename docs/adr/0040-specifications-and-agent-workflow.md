# ADR-0040: Durable specifications and agent workflow

Status: accepted by the owner's implementation request. Date: 2026-09-11.

## Decision

Adopt the documentation model and adapted development workflow from
[Visual Thinker](https://github.com/PlaygrndLabs/visual-thinker/blob/main/AGENTS.md).
[AGENTS.md](../../AGENTS.md) defines how agents work;
[SPECS.md](../../SPECS.md) is the authoritative intended product definition;
[TASK.md](../../TASK.md) records actual implementation, activation, blockers, and
evidence. XML containers provide semantic structure, with Markdown content inside.

Specs collect accepted user requirements as absolute, stateless definitions with
close wording fidelity. They do not encode implementation progress or turn every
observed code detail into a requirement. Plans retain execution order and acceptance
procedures; ADRs retain rationale and supersession history. Unresolved wording and
unaccepted proposals remain outside the product definition.

This supersedes the distributed specification and agent workflow in older plans
and AGENTS.md. Existing accepted ADRs remain unchanged. Product decisions follow
their recorded supersession chain: this consolidation changes no runtime behavior
and grants no new provider, memory, external-action, or release activation.

## Working agreements

Use one dedicated worktree per task session on a `codex/` branch from main. Make
one verified commit per feature or distinct setup step, with chronological faithful
user-prompt excerpts in its body. Serialize integration through an exclusive lock
in the shared Git directory; merge each verified increment into main and push
origin/main. This extends ADR-0039's integration authorization to subsequent work;
release and live activation gates remain separate. Report unavailable remote
synchronization honestly and preserve other sessions' work.

The owner selected targeted behavior tests without a TDD mandate. Existing suites
and acceptance gates remain. npm, TypeScript, Python, React, and local Compose are
retained; Visual Thinker's Bun, Tailwind, no-tests, and Cloudflare choices are not
Nocheh requirements.

The owner selected documentation and instructions only. Visible terminal and
internal-browser previews apply when a suitable session environment exists.
Per-session Compose/port/state isolation and the missing Makefile dev recipe are
explicit follow-ups, not delivered tooling. No runtime startup or preview is
required to verify this documentation change.

## Requirement coverage and supersession

| SPECS.md area | Decision sources and resolution |
| --- | --- |
| Mission, foundation, archive, imports | ADR-0018 retains the personal-brain mission; ADR-0019 selects local Compose; ADR-0027 gives Nocheh product ownership; ADR-0036 unifies packaging |
| Guarded projections | ADR-0020's mandatory per-attempt boundary, superseded on representation/modes by ADR-0033's durable editable on/off projections; ADR-0037 adds external enforcement |
| Memory and audience | ADR-0030 supersedes fixed group-only memory; ADR-0033 makes Honcho primary while preserving native memory and explicit import consent |
| Providers and transcription | ADR-0034 defines dedicated embeddings; ADR-0035 defines shared subscription reasoning and refresh ownership; activation remains separately gated |
| Runtime, controlled tools, scheduling | ADR-0027–0029, ADR-0031, and ADR-0037 define managed execution, exact effects, and isolation; later security rules supersede credentialed agent children |
| Dashboard, CLI, evidence graph | ADR-0024–0027 establish configuration and UI; ADR-0027 supersedes the Hermes-hosted shell; ADR-0026 retains the local accessible 3D evidence presentation |
| Monitoring and OAuth recovery | ADR-0035 and ADR-0038 define provider monitoring, observed Telegram health, and the local callback |
| Operations and acceptance | ADR-0023 and ADR-0032 define inactive recovery and portable memory; ADR-0039 separates main integration from release; this ADR governs subsequent agent integration |

The migration retains pending Telegram acceptance, shared-provider sign-in/cutover,
Honcho embeddings and ingestion/recall activation, native-note/transcript filtering,
and live memory/privacy checks in TASK.md. Inngest remains an unaccepted proposal.
Legacy persisted-data migration is not introduced by this documentation change.

## Verification

Review coverage against accepted decisions and the existing active plans. Check
local document links, XML nesting, stateless wording, proposal/status separation,
and references from plans to the canonical specification. Confirm all pre-existing
accepted ADR files and all runtime files are byte-for-byte unchanged. No automated
test additions or runtime activation are part of this change.
