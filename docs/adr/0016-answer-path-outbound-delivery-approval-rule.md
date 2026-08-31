# ADR-0016: The Answer Path, Outbound Delivery, And The Amended Approval Rule

## Status

Accepted. Amends rule 3 in `AGENTS.md`.

## Context

The owner defined the MVP as three things: it answers me, fast and grounded; the approval
loop is closed in the UI; and it delivers a daily brief and a weekly review. Measured
against the code, the first and third do not exist in any partial form.

- **There is no outbound transport.** `TelegramClientPort` exposes `getMe`, `setWebhook`,
  `getWebhookInfo`, `getFile`, `downloadFile`. There is no `sendMessage`.
- **`AssistantAiPort` is dead code.** It is the only interface in the repository with a
  `replyText` field. It has zero implementations, `NoopAssistantAi` is never instantiated,
  and `replyText` is never read anywhere in `src/`, `test/`, or `web/`.
- **`AssistantReplyMode` is dead configuration.** `"silent" | "mention" | "active" |
  "digest"` is persisted, exposed through the settings API, editable in the dashboard, and
  branched on by nothing.
- **The analysis contract has no reply field**, and neither does `MemoryGraphAnalysis`.
- **`MemoryQueryService`** — `decisions()`, `openBlockers()`, `projectStatus()`, the closest
  thing to a read API — is not wired into `dev-server.ts` or any route. Its only caller is a
  test.
- **There is no scheduler**, only the flush sweep.

So the retrieval half of a question-and-answer path is real and runs on every window,
while the generating half does not exist at all. This matters for sequencing: the importer
core and the Postgres migration are foundations that move the stated MVP zero inches on
their own.

There is also a latency problem that forbids the obvious shortcut. Analysis takes 189–240
seconds. An answer must arrive in seconds. Extending the analysis contract with a reply
field would put the answer behind the slowest call in the system, and would couple a
read that must be cheap and frequent to a write that is expensive and rare.

Finally, the owner chose to amend rule 3 to permit autonomous sending. Rule 3 currently
reads: *external effects stay `pending`; Nocheh may draft and suggest; it must not
impersonate the owner or act on its own.* Rule 3 is the reason the suggestion lifecycle
exists, and lifting it entirely would allow a model that has never been observed extracting
a single node correctly against a live window to message a client on the owner's behalf.

## Decision

**A reply contract separate from the analysis contract.** `AnswerQuestionUseCase` takes a
question, builds grounding from records, graph and accepted rules under a token budget, and
calls a `text_completion` role with its own prompt and its own small output contract:
answer text, the source ids it used, a confidence, and an explicit "I don't know" branch.
It never writes to memory. Two contracts, two latency classes, two cost profiles — an
answer must be measured in seconds and analysis is allowed minutes.

**Answers cite their sources.** Every reply carries the record and node ids it was built
from, rendered as a short provenance line. An unsourced answer from a memory system is
indistinguishable from a guess, and the owner has to be able to catch a wrong one.

**One egress, and everything goes through it.** `OutboundDeliveryService` is the only code
path that can send anything anywhere. `TelegramClientPort` gains `sendMessage`. Replies,
briefs, reviews and approved external actions are all deliveries, and every delivery writes
an audit record with what was sent, to whom, why, which policy allowed it, and whether a
human approved it. A send that is not in the audit trail is a bug.

**`AssistantReplyMode` becomes load-bearing.** `silent` never sends. `mention` answers when
addressed. `active` may answer unprompted in a monitored chat. `digest` only delivers
scheduled output. The value is already stored and already editable; this wires it.

**The scheduler generalises the flush sweep.** Jobs carry a prompt, a projection or query,
a delivery target, and a cadence — Hermes's "first-class agent tasks, not shell tasks"
design, reimplemented. Daily brief and weekly review are the first two jobs, and both
deliver through the single egress.

**Rule 3 is amended, with a ceiling rather than a switch.** New text:

> External effects default to `pending`. The owner may grant Nocheh authority to send
> without prior approval, within a written policy, and every autonomous send is audited and
> reversible in the record. Nocheh must never present itself as the owner.

The policy has named limits, all of them enforced in the domain rather than the prompt:

- **Risk ceiling.** Only suggestions below a configured `riskLevel` may auto-send.
  `external_action` kinds above it stay `pending` regardless of any setting.
- **No first contact.** Nocheh may reply in a conversation the owner has already spoken in;
  it may never open one.
- **Content exclusions.** No money, no credentials, no commitments on the owner's behalf —
  no amounts, no payment details, no contractual acceptance. These are refusals in the
  domain, not instructions in a prompt.
- **A daily cap** on autonomous sends, per conversation and in total, with the cap exhausted
  meaning fall back to `pending` rather than silently dropping.
- **A kill switch** that stops all egress immediately, independent of every other setting
  and reachable without a working model.
- **Attribution.** Every autonomous message is visibly marked as sent by Nocheh. The
  amended rule permits acting; it does not permit pretending.
- **A mandatory dry-run period.** Autonomy cannot be enabled until the owner has reviewed a
  configured number of drafts that *would have* been sent. The system earns the permission
  with a visible track record.

**Approval stays on by default**, which is what the owner asked for: the loop is closed in
the UI first, autonomy is opt-in afterwards, and the dry-run gate sits between them.

## Consequences

- This is the MVP, and it is a new subsystem rather than a refactor: reply contract, answer
  use case, outbound port method, delivery service, policy domain, scheduler, and the UI to
  approve and to watch. Nothing in the persistence work substitutes for it.
- `AssistantAiPort` is deleted rather than implemented. It predates the graph, the audit
  trail and the model roles, and a fresh contract is cheaper than reviving a dead one.
- Nocheh becomes capable of harm for the first time. Every limit above exists because the
  failure mode is no longer "a wrong row in a table" but "a message a client read".
- The kill switch and the audit trail are load-bearing, not conveniences. Neither may depend
  on a model, a provider, or a network call.
- Rule 3 in `AGENTS.md` is replaced by the amended text when this phase lands. Rules 4 and 5
  are untouched: suggestions are still not facts, and there is still no auto-trading.
