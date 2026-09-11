# ADR-0027: Nocheh owns the product; Hermes is a replaceable runtime

Status: accepted. Date: 2026-09-07.

The owner selected Nocheh as the main application with a dedicated native Hermes
dashboard page, full native operations, broader controlled tools, and configurable
approval policies. This supersedes ADR-0025's Hermes-hosted presentation. The earlier
uncommitted draft described the opposite navigation; it was never a completed phase.

Nocheh owns its dashboard, CLI, archive/files, source identities, scope policy,
guarding, approvals and integration lifecycle. Hermes provides the agent, native
Telegram adapter, native tools, profiles, sessions and built-in memory. A focused
runtime adapter isolates native protocols and identifiers. Only Hermes is implemented
now; a replacement harness must pass the same capability and scope contracts.

Nocheh loads independently at `/`. The native dashboard opens at `/hermes/` with
native navigation and a Back to Nocheh extension. Preserve existing CLI commands,
`/nocheh` bookmarks and owner API aliases. Native pages use actual runtime state.
Unavailable capabilities remain explicit until their acceptance checks pass.

Browser input defaults to owner-private scope. An explicitly selected group remains
group-scoped through storage, tools, sessions and memory. Browser text and attachments
must be committed before interpretation or inference. Scheduled triggers have their
own source identities. Generated artifacts never replace captured originals.

Every managed execution path, including native TUI children and cron, installs the
same capture, per-attempt guard and tool-policy boundaries. One supervisor owns
Telegram polling, scheduler lifecycle and subscription refresh. Broad tools run in
scoped workspaces; external effects require exact approval or an owner-authored,
bounded standing permission. The default is review each action. Group participants
cannot approve actions or edit administrative policies.

Nocheh policies have global defaults, profile overrides and job overrides, visible
with effective values and revisions. Native preferences stay in native configuration;
deployment secrets stay in the existing .env/native OAuth mechanisms. Writes use
shared validation and concurrency controls. Existing production constraints remain:
subscription models, optional off/on/auto guarding, explicit trust, immutable
originals, no auto-trading, and no release before the remaining live gates pass.

The [seven-phase implementation plan](../runtime-platform-plan.md) defines acceptance.
Commit each verified phase separately and continue automatically. TASK.md records
actual status. Local Compose remains the target; VPS and a second harness are deferred.
