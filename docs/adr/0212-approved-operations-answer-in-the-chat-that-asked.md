# ADR-0212: Approved operations answer in the chat that asked

<status>
Accepted on 2026-11-08, after the owner decided that once an approved operation
ends, the agent continues in the chat that asked and posts the answer there. The
details follow the recommendations the owner was shown: the answer is a reply to
the asking message in its topic; a rejected, failed or unconfirmed operation still
gets one short line; one asking message gets at most three follow-ups; and the
first reply says the answer will follow. Amends
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md): the group
hears the outcome, not only that the owner was asked. Amends
[ADR-0202](0202-approved-actions-report-how-they-ended.md): the agent says the
answer will follow. Keeps [ADR-0028](0028-isolated-native-browser-turns.md)'s
native auto-continuation disabled: this is a continuation Nocheh admits and
receipts.
</status>

<context>
- A shell, browser or MCP operation asked for in a group waits for the owner's
  press in their private chat. The press comes after the asking turn has ended, so
  until now the result reached only the owner's card; the group heard "I asked the
  owner" and nothing more.
- Hermes's own approval gate waits inside a turn and keeps its state in that turn's
  process. It has no path for an answer that arrives after the turn ends, and it
  lets whoever is in the chat approve, which ADR-0159 does not allow.
- Hermes continues a session after background work the same way every time: it
  builds an internal, synthetic `MessageEvent` and feeds it to the adapter's
  `handle_message`, so the agent picks up the same session in the same chat or
  topic (`gateway/wake.py`). Nocheh's committed adapter already overrides
  `handle_message`, with its own delivery checks and reply anchor.
- Every end of a controlled operation commits in one of a few places: a receipt,
  an expired lease, a block before start, an owner rejection or an owner cancel.
</context>

<decision>
- **Trigger.** A database trigger on `controlled_actions` writes one
  `action_continuations` row and requests one `telegram` workflow with job id
  `continue:<action>` in the same commit as the end state (done, failed, ambiguous
  or rejected). Only operations of a live conversation qualify: a job's operations
  (with a `job_id`) and scheduled runs (a control source) are answered by their
  report. A late receipt fires again and changes nothing.
- **When it runs.** The follow-up waits, each wait bounded, for the asking turn's
  own reply to end (10 minutes), for another follow-up of the same message that has
  not ended, whether claimed, running or failed with a retry left (10 minutes), for
  a late receipt of an operation whose lease expired (2 minutes), and for sibling
  operations of the same message that are approved, running or awaiting such a
  receipt (2 minutes). A request still waiting for the owner holds nothing.
- **Merge, cap and skips.** The first follow-up to run claims, under a per-message
  lock, every other ended operation of that message in the same space and profile,
  and answers them in one turn; their own jobs end as merged. A sibling still
  awaiting a late receipt is left to its own job, so its answer is not reported as
  unconfirmed. One asking message gets at most three follow-ups. No follow-up runs for: the owner's own private
  request that the owner rejected; a Notion call its own request approved that
  ended within 55 seconds, since the asking turn already waited for it; anything
  but a live Telegram message; a chat no longer served or a member no longer
  allowed; a retired message; a changed space or profile.
- **Reader and checks.** The follow-up rebuilds the asking reader the way the reply
  did, at the current binding, and requires the operation's own space and profile,
  the rule `nocheh_action_status` applies. It mints the same ten-minute turn
  credential for the asking event, records its input as a derived
  `runtime_context`, fences the binding when it starts, and starts asynchronously.
- **Gateway.** The runtime accepts a follow-up only with `continuation` set to the
  action id and a string attempt `c<n>-<first 40 hex of it>`, and without a fixed
  control reply. It skips group admission, since the asking turn was already
  admitted, and enters through an internal `MessageEvent` built by the adapter's
  own `_build_message_event`, with `internal` set and gateway control off. The
  answer goes out through the committed adapter as a reply to the asking message
  in its topic, under the usual delivery checks.
- **Receipts and keys.** A follow-up's attempt names its AsyncRuns run, its gateway
  receipt and its archived answer, so they never meet a message turn's. Its
  outbound journal key is the asking update's key plus `:continuation:<action>`.
  Its result is a derived `runtime_result`. A failure before delivery is retried as
  a new attempt, three in all; an uncertain delivery is final.
- **Wording.** The turn starts with the owner-editable text
  `telegram.action_continued`, which lists only each operation's id, tool and
  state; the model reads each result itself through `nocheh_action_status`, under
  its own audience check. When the owner is asked privately, the agent says in the
  group that it asked the owner and that the answer will follow there. An
  operation approved by the owner freedom setting says its answer will follow.
  Once the asking message has had three follow-ups, no reply says that.
- **Authority.** A follow-up is a turn Nocheh starts on operation results, not a
  new owner request. While one runs for an asking message, the owner freedom
  setting and the owner's Notion setting approve nothing asked for under that
  message, so a result's text cannot make it act or send to another chat without
  the owner's card; it is approved like background work. A follow-up first waits
  for the asking reply to end (up to ten minutes), so the owner's own turn keeps
  the setting. The same-group rule for a message is unchanged.
- **Epochs.** A running follow-up holds reaction and learning epochs, exactly as a
  running reply does.
- **Alert.** The answer is sent with Hermes's notify mark, as Hermes's own final
  replies are, since nobody is watching the typing when it comes.
</decision>

<consequences>
- An asking message gets one extra turn when its operations end, at most three.
  It costs one more model turn under the same broker and cost limits.
- Reactions and automatic learning wait while a follow-up runs.
- The owner's Workflows page shows a follow-up under the asking message, cancels
  one that has not started, and retries one that failed before its third attempt.
- A follow-up interrupted by a runtime restart ends as uncertain and is not
  reopened: the journal check that reopens a reply is not mirrored yet.
- Follow-ups add no stage timings or engine receipts; their own rows and derived
  records are the receipt.
</consequences>
