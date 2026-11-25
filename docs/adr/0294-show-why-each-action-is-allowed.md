# ADR-0294: Show why each action is allowed

<status>
Accepted on 2026-11-24. The owner approved both from a comparison with another personal
assistant: "start all three + Because you said". Amends
[ADR-0266](0266-schedules-set-by-asking.md) and [ADR-0290](0290-nocheh-grants-schedule-changes-and-fires.md)
for schedules a reply set after reading outside content; both stay as written for everything
else. Changes the owner's earlier rule that a schedule set by asking runs with no card, in that
one case only. Amended on 2026-11-24: the owner chose that an archive search holds a schedule
too ("Hold it for Start"), since a stranger's group message it finds could otherwise set a
daily job.
</status>

## Context

A schedule set by asking runs every day with nobody watching, and its message did not show
what it would do. A web page, an email, a file or a forward that the same reply read could
have written that instruction. Separately, an action that ran without a card (a rule, the
owner's "Do what I ask", a group's tools permission, a connection setting) left no plain trace
of why it was allowed.

## Decision

1. **The schedule message shows its instruction.** Nocheh's message about a new schedule adds
   `📝 Does: …`, the instruction Nocheh saved (cut at 700 characters; the Schedules page has
   all of it). A press that edits the message keeps that line, read from the saved version.
2. **Outside content holds a schedule.** A turn whose message or reads brought in outside
   content (ADR-0293's `outsideReads` for the asker, the owner or a member in their own chat:
   a forward, a file, a reply to someone else's message, earlier outside content in the
   conversation, a web page or another server's tool, Gmail and Notion included, and a
   search of the archive, whose results hold other people's messages; not a conversation
   the runtime never reported)
   may not leave a schedule running
   unless it already ran with that very instruction. `/v1/schedules/turn/definition` answers
   409 `schedule_start_needed`; Hermes's plugin then saves the job paused, with a new
   execution version, and posts it again in the same turn. Nocheh records it and answers
   `held: true`. A pause or removal from such a turn needs nothing more.
   The schedule tool's own result is not outside content: a schedule set, changed or removed
   earlier in the conversation holds nothing later. A list of schedules is, since it shows
   prompts a held turn may have shaped.
3. **Start.** The held schedule's message says it is paused and why, and has ▶️ Start
   (`nks…`) and Delete instead of Pause. Start is the person's own press, granted as a
   resume (ADR-0290), and only the latest message about a schedule
   (`workflow_schedules.notice_id`) is edited. A changed schedule held this way gets its own
   message, named as changed. A later turn with only the person's own words may also turn
   it on.
4. **Because.** Why an action ran is read from records Nocheh already keeps, never stored
   again: the first `allowed` security event with a grant names the authority
   (`exact_owner_approval`, `owner_autonomy:*`, `same_group_request`,
   `owner_private_request`, the scheduled-chat grants, `group_tools`, a connection setting,
   or an allowance's id in `action_permissions`); the asking message, the run's schedule
   (with the words that set it) or the job says who asked. `ActionBecause` builds both.
5. **Where it shows.** Inbox › History › Actions has a Because column, and an action's drawer
   shows Because and Asked by. A card in the owner's private chat for a request made in
   another chat adds `🗣 You said: “…”` or `🗣 “Name” said: “…”` (`asked_you`,
   `asked_member`), from the template's `{asked}`; it is the first line to give way on a
   long card.

## Consequences

- A planted instruction cannot become a running daily job without the person's Start.
- Older Hermes plugins that do not know `schedule_start_needed` remove the new job instead,
  which fails closed.
- Follow-ups that ran under a rule do not quote the rule in the chat; the History shows it.
