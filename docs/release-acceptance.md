# Remaining local release acceptance

[SPECS.md](../SPECS.md) defines release requirements; [TASK.md](../TASK.md) records
actual implementation and acceptance. This file supplies the remaining live procedure.
These checks need actual incoming Telegram traffic; synthetic archive events and
healthy containers cannot substitute for it. Credentials are already configured.
No VPS or Honcho key is required.

Use only synthetic text. Record event IDs, scoped profile IDs, derived record IDs,
delivery receipts and timestamps in content-free evidence under
`compatibility/results/`. Do not commit tokens, real chat contents or numeric chat
identities. The owner can inspect the corresponding originals in Archive/Activity.

| Check | Owner input / expected evidence |
| --- | --- |
| Intentional silence | In the selected group send `Nocheh acceptance: no answer needed; this is a logging-only note.` Verify one captured original and a completed silent decision with no reply receipt. |
| Private/group isolation | In the owner DM send `Remember this private synthetic marker: NOCHEH_PRIVATE_RELEASE_20260908.` Then in the selected group ask `What private synthetic marker did I tell you in our DM?` Inspect the group-bound retrieval trace and answer; the marker and private source must be absent. Policy must not share that source. |
| Voice persistence | Send a short Telegram voice note in the owner DM saying `Nocheh voice acceptance, the orange lantern is ready.` Verify original audio bytes and hash, the captured Telegram envelope, a separate transcript with provenance, and the reply's source link. |
| Exact owner approval | In the owner DM ask `Propose a message to this private chat with exactly: NOCHEH_APPROVED_DELIVERY_20260908. Wait for approval.` Inspect the exact destination/text, approve that one action in Activity or with `/approve FULL_ACTION_ID`, then verify one confirmed Telegram receipt and no second send on replay. |
| Reconnect/restart | Send `NOCHEH_RECONNECT_20260908: please acknowledge once.` Allow capture, restart the supervised runtime, inspect durable identity and receipt recovery, and confirm one response. Repeat after reconnect only if the first attempt is unresolved; do not manufacture incoming events. |

The assistant may inspect results and prepare the checks. Sending test messages or
approving an external delivery on the owner's behalf requires explicit owner
authorization for those actions. Group members cannot approve or change policy.

Before cutover, all checks must pass and restored pending work must be reconciled
against the source installation. Verified Git integration follows
[AGENTS.md](../AGENTS.md) independently under ADRs 0039–0040; it does not complete
these checks or activate the runtime. The optional Honcho comparison remains
independent and does not block this production gate.
