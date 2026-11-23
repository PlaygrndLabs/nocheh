# ADR-0277: Members' own schedules

<status>
Accepted on 2026-11-23, as step 3 of "Add morning brief and focus list". The owner
decided on 2026-11-20: members get schedules by permission, a switch called "Personal
assistant", off by default; a member approves their own schedules, with no owner card;
at most 5 per member, which the owner can change; the owner sees every member's
schedules on the dashboard; and a member's run never reads the owner's or another
member's private chat. Extends [ADR-0266](0266-schedules-set-by-asking.md) (the same
tool, gate, capture, message and Schedules page) to a member's own private chat
([ADR-0262](0262-member-private-chat.md)). Amends
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md) and
[ADR-0265](0265-member-mini-app.md) D10 for two kinds of send to a member's chat: their
own scheduled result and the message about a schedule they set.
</status>

## Context

ADR-0266 lets the owner set schedules by asking in their private chat. Members talk to
Nocheh in their own private chat too, which reads only that chat and the groups they
joined (ADR-0262). A member who wants a morning brief of their groups should get the same
thing in their chat, without the owner approving each schedule or each result, and
without any run reaching more than that member may read.

## Decision

1. **Personal assistant, per member.** A member switch under "Private chat with Nocheh"
   on the Members page, off by default and kept while private chat is off. It counts only
   while the member is active and their private chat is on (`members.assistant`,
   `MemberDirectory.assistant`, `memberAssistant`). The served list marks such a chat
   `member_assistant`, and only then is it one of the agent's profiles
   (`member-<name>-<code>`).
2. **Set by asking, within a cap.** The member's own live message in their private chat,
   not a forward, gets Hermes's schedule tool as the owner's does (ADR-0266 1-3): exactly
   one of an owner turn or a member turn, isolated, with that chat's store mounted.
   `/v1/schedules/turn` also gives the cap, "Schedules per member" on the Members page
   (`member_directory_state.member_schedules`, 1 to 50, default 5), and how many the chat
   keeps now; the gate refuses a new one past it. A member's schedule runs in the owner's
   time zone unless they name another (their own setting since
   [ADR-0281](0281-members-own-time-zone.md)). The member's reply prompt is editable
   (`reply.member_schedules`).
3. **A run reads as that member.** A captured run in a member's chat runs only while
   Personal assistant is on. Storage binds it as that member, with the reads their private
   chat has now (their chat and their joined groups), a running scheduler run standing in
   for the live turn `bindReads` otherwise needs. It reads their tasks as their private chat
   does, read only, and never the owner's data or any other private chat. Hermes's
   scheduler runs it with that member's scope and cancels it if storage and the served list
   disagree.
4. **Results with no card in their own chat.** A member's scheduled result for their own
   chat is a trusted `scheduled_run` send under the standing rule `member_scheduled_chat`,
   through the usual guard and delivery path. A result that is only `[SILENT]` is not sent.
5. **Nocheh's message, with Pause and Delete.** Once captured, the schedule gets the same
   message as the owner's, in the member's chat. Core gives the bot a one-time yes for that
   chat and that exact text (`schedule_notice_grants`, through
   `/internal/notices/authorize`), and the bot takes only a plain notice there, with no
   topic, sent or edited, with no buttons or only its Pause and Delete presses. Only the
   member's own press in their own chat acts on them.
6. **The members' app.** Settings shows the member's own schedules while Personal assistant
   is on (`GET /schedules`, `POST /schedules/:id` with pause, resume, run or delete): name,
   how it repeats, next run in the phone's time, and whether the last run failed. Never the
   prompt, the chat, the profile or a time zone name. Only that chat's schedules are listed
   or changed, and each change counts against the member's write limit.
7. **The owner sees all.** The Schedules page lists a member's schedule as "Private chat of
   <name>" with the same Pause, Resume, Run now and Delete.

## Consequences

- Turning Personal assistant off, turning private chat off, or pausing or removing the
  member stops their schedules from being captured, run or sent; Hermes keeps them, and
  they run again once the member has it back. While it is off the owner's Schedules page
  does not list them.
- Each run uses the owner's provider, so the cap bounds the cost per member.
- A reset of the setup keeps each member's switch but sets the cap back to 5.
