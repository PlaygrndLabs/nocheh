# Local release acceptance

[SPECS.md](../SPECS.md) defines release requirements; [TASK.md](../TASK.md) records
actual implementation and acceptance. This file supplies the repeatable live procedure.
The consolidated installation passed these gates on 2026-09-16; see the
[recorded acceptance](../compatibility/results/2026-09-16-consolidated-services.json).
These checks need actual incoming Telegram traffic; synthetic archive events and
healthy containers cannot substitute for it. Credentials are already configured.
No VPS or Honcho key is required.

When the reset preflight reports the legacy storage layout, the frozen setup must
pass the legacy-to-original-only conversion before fresh services are created. The
private transition receipt must show the exact saved legacy configuration hash,
the target hash differing only by `NOCHEH_STORAGE_LAYOUT=original-only-v1`, and an
applied state. Inspect the converted sharing rules and custom runtime profiles in
the private setup request before the empty-baseline phase retires it. Any unknown
legacy policy field, self-sharing source, or unrelated configuration change blocks
the reset for review.

For the deliberate reset acceptance, record these checks in the private reset
journal as a `nocheh-fresh-acceptance-v1` request. Use the current post-boundary
event and receipt IDs; do not reuse the historical evidence linked below. The
request carries hashed group and participant identities, the reset ID, new
generation, exact backlog-confirmation time, and owner-inspected booleans. The
reset-only validator independently checks the referenced archive, derivative and
control rows before any saved restart policy can be restored. Healthy containers,
fixture traffic and an operator checklist without current row references cannot
complete the gate.

Use only synthetic text. Record event IDs, scoped profile IDs, derived record IDs,
delivery receipts and timestamps in content-free evidence under
`compatibility/results/`. Do not commit tokens, real chat contents or numeric chat
identities. The owner can inspect the corresponding originals in Archive/Activity.

| Check | Owner input / expected evidence |
| --- | --- |
| Intentional silence | In the selected group send `Nocheh acceptance: no answer needed; this is a logging-only note.` Verify one captured original and a completed silent decision with no reply receipt. |
| Private/group isolation | In the owner DM send `Remember this private synthetic marker: NOCHEH_PRIVATE_RELEASE_20260908.` Then in the selected group ask `What private synthetic marker did I tell you in our DM?` Inspect the group-bound retrieval trace and answer; the marker and private source must be absent. Policy must not share that source. |
| Voice persistence | Send a short Telegram voice note in the owner DM saying `Nocheh voice acceptance, the orange lantern is ready.` Verify original audio bytes and hash, the captured Telegram envelope, a separate transcript with provenance, and the reply's source link. |
| Exact owner approval | In the owner DM ask `Use nocheh_action_request with destination current to propose exactly: The orange lantern is ready. Wait for my approval.` Inspect the exact destination/text, approve that one action in Activity or with `/approve FULL_ACTION_ID`, then verify one confirmed Telegram receipt and no second send on replay. |
| Reconnect/restart | Send `Nocheh restart acceptance: please acknowledge once.` Allow capture, restart the supervised runtime, inspect durable identity and receipt recovery, and confirm one response. Repeat after reconnect only if the first attempt is unresolved; do not manufacture incoming events. |

The reset request also requires a current normalized reply and a reaction from a
non-owner human in the dedicated group, active learned-memory recall after the
owner correction, and the exact completed Honcho projection receipt. Honcho must
repeat subscription reasoning, guarded embedding, ingestion, retrieval, restart,
and provider-failure recovery within the existing spending cap; its verified
connection, ready workspace, context snapshot and ingestion receipt must all be
newer than the reset backlog boundary.

Use a plain sentence for the exact-delivery test. The privacy guard can mask
identifier-like synthetic markers before the assistant sees them. If it does,
retain that evidence and choose a new harmless phrase; do not disable guarding.
Send approval commands without Markdown backticks or trailing punctuation.

The assistant may inspect results and prepare the checks. Sending test messages or
approving an external delivery on the owner's behalf requires explicit owner
authorization for those actions. Group members cannot approve or change policy.

Before cutover, all checks must pass and restored pending work must be reconciled
against the source installation. Verified Git integration follows
[AGENTS.md](../AGENTS.md) independently under ADRs 0039–0040; it does not complete
these checks or activate the runtime. The optional Honcho comparison remains
independent and does not block this production gate.
