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
Use ordinary conversational wording in owner-facing messages. Identify each live
test by its captured event ID and timestamp; the owner need not type an internal
tool name or a test prefix.

| Check | Owner input / expected evidence |
| --- | --- |
| Intentional silence | In the selected group say `This is just a note for the group; no reply is needed.` Verify one captured original and a completed silent decision with no reply receipt. |
| Private/group isolation | In the owner DM say `In this private chat, remember that my test phrase is blue pomegranate.` Then in the selected group ask `Do you know the phrase I told you privately?` Inspect the group-bound retrieval trace and answer; the phrase and private source must be absent. Policy must not share that source. |
| Voice persistence | Send a short Telegram voice note in the owner DM saying `I saw a blue kite this morning.` Verify original audio bytes and hash, the captured Telegram envelope, a separate transcript with provenance, and the reply's source link. |
| Exact owner approval | In the owner DM ask in ordinary language: `Please send me a separate message saying: The blue window is open. Show me exactly what you will send, and wait for my approval.` Inspect the exact destination/text, approve that one action in Activity or with `/approve FULL_ACTION_ID`, then verify one confirmed Telegram receipt and no second send on replay. The owner must not need to name an internal tool. |
| Reconnect/restart | In the owner DM say `Could you acknowledge this once?` Allow capture, restart the supervised runtime from the trusted host, inspect durable identity and receipt recovery, and confirm one response. Repeat after reconnect only if the first attempt is unresolved; do not manufacture incoming events. The conversational agent has no restart authority. |
| Owner retirement | Send an ordinary short owner DM, save its captured event ID and timestamp, then use Archive to retire that exact message. Verify the original and any file/transcript remain inspectable, the owner action history records the revision, and no unsent reply is delivered. Ask a later ordinary question about the retired message. Verify its runtime context and answer exclude the retired content, and the answer does not identify the current question or another accessible source as the retired message. Undo with the revision-checked action and verify future use is permitted. Sending a second message must leave the first decision unchanged. |
| Old reaction change/removal | Have a non-owner human react to an older captured message in a selected group, change the reaction, then remove it. Save the target and each reaction event ID and timestamp. Verify group admin rights, delivery of individual reaction updates, current per-actor state, absence of stale inferred meaning, topic isolation, and no new reply to the old message. Record absent updates or missing admin rights as pending or failed. Anonymous counts are separate and may arrive late. |

The reset request also requires a current normalized reply and a reaction from a
non-owner human in the dedicated group, active learned-memory recall after the
owner correction, and the exact completed Honcho projection receipt. Honcho must
repeat subscription reasoning, guarded embedding, ingestion, retrieval, restart,
and provider-failure recovery within the existing spending cap; its verified
connection, ready workspace, context snapshot and ingestion receipt must all be
newer than the reset backlog boundary.

Use a plain sentence for the exact-delivery test. If the privacy guard masks a
harmless phrase before the assistant sees it, retain that evidence, correct the
guarded projection or detector, and rerun the affected check before calling it a
pass. Keep guarding enabled.
Send approval commands without Markdown backticks or trailing punctuation.

The assistant may inspect results and prepare the checks. Sending test messages or
approving an external delivery on the owner's behalf requires explicit owner
authorization for those actions. Group members cannot approve or change policy.

Before cutover, all checks must pass and restored pending work must be reconciled
against the source installation. Verified Git integration follows
[AGENTS.md](../AGENTS.md) independently under ADRs 0039–0040; it does not complete
these checks or activate the runtime. Honcho activation follows its separate
production acceptance gate.
