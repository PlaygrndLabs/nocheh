# Nocheh runtime platform implementation

Accepted 2026-09-07, ADR-0027. Nocheh is the product and Hermes is its first runtime
adapter. Each phase is verified and committed separately; continue automatically.
Preserve the archive, native profiles and memory, current credentials and 3D graph.

## Dashboard

Nocheh owns Overview, Archive, Imports, Memory, Graph, Activity/approvals,
Integrations, Settings and Maintenance. Imports retain upload/preview/start/cancel/
resume. Memory distinguishes generated notes from cited originals. Hermes opens
on its own native page for chat, sessions, profiles, files, models, configuration,
skills/plugins/MCP, cron, channels and system controls. Native operations use actual
runtime state and become available only after their integration is verified.

## Phases and acceptance

1. **Ownership and adapters:** isolate native RPCs behind capability-checked runtime
   operations; preserve Telegram identities; represent browser/scheduler originals.
   Acceptance: existing dispatch, management, errors and archive round-trips pass;
   a replacement fixture satisfies the runtime contract.
2. **Independent dashboard:** own React application at `/`; native page at `/hermes/`
   with a return link, authenticated HTTP/WebSocket proxy and legacy route aliases.
   Acceptance: navigation, refresh, downloads and mobile work; Nocheh starts with
   Hermes unavailable and never loads a covering interface over native content.
3. **Configuration and administration:** actual native data; shared revision-checked
   writes; global/profile/job policy settings and effective-value provenance; preserve
   native configuration and scope bindings. Acceptance: real state, CLI/UI round-trip,
   write conflicts, credential protection and side-effect-free inspection.
4. **Native browser chat:** native TUI through mandatory managed bootstrap; capture
   submitted originals and files before execution; owner-private default and explicit
   group scope; guard every model attempt; single refresh authority and reconnect IDs.
   Acceptance: chat, resume/cancel, capture failure, scope, guard, quota/refresh and
   reconnect without duplicate submission. Start with the existing restricted tools.
5. **Broader tools and approvals:** controlled shell/browser/MCP, scoped workspaces,
   mediated network/external writes; exact action approvals and revocable bounded
   standing permissions. Dashboard and owner Telegram commands share decisions.
   Acceptance: approval/denial, revocation, argument changes, escape prevention and
   uncertain delivery handling. Default external policy is review each action.
6. **Native cron:** native management and one supervised scheduler; shared managed
   execution, explicit scope, local default results, configurable delivery approval,
   durable fire IDs, visible missed runs and explicit catch-up option. Acceptance:
   restart, overlap, cancellation, approval, missed runs and no duplicate effects.
7. **Compatibility and release acceptance:** pinned image-built native assets, small
   compatibility patch, candidate-upgrade tests, isolated state rehearsal, backup and
   rollback; CLI runtime/policy/approval operations; portable sources and memory with
   provenance; AST-only Graphify refresh. Acceptance: UI/CLI regression, outage,
   rollback and remaining real Telegram/voice/isolation/approval/reconnect gates.

## Compatibility and defaults

Primary owner API: `/api/nocheh/*`. Preserve `/api/plugins/nocheh/*` and `/nocheh#…`
aliases. Browser auth belongs to Nocheh; provider and internal credentials never go
to the browser. Native transport contracts live in the Hermes integration only.
Persist settings revisions and reject stale writes. New profiles are owner-private;
managed group profile mappings cannot be widened through native forms.

Owner policies expose defaults, profile overrides and job overrides, including
guard/trust, tools, approvals, model preferences, memory limits, run budgets,
scheduling and retries. Global production invariants remain enforced. Native update
and gateway controls use Nocheh's supervisor; no second poller/scheduler/refresh owner.

Keep Bash and the existing optional Honcho CLI. Honcho production use, additional
messaging platforms, a second harness, a plugin marketplace and VPS are deferred.
ADR-0039 supersedes the original branch sequencing: the owner authorized refactor
integration into `main` on 2026-09-11. Missing live credentials/evidence remain
pending and cannot be reported as a completed phase or release.
