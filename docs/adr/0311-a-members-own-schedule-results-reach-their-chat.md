# ADR-0311: A member's own schedule results reach their chat

<status>
Accepted on 2026-11-25. The owner chose "Yes, send to their chat" after a tester finding: a member with Personal assistant on could set a schedule, which ran, but each result was
held back when Telegram had not yet seen that member in a served group. Fixes
[ADR-0277](0277-members-own-schedules.md) D4, which amended
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md) for a member's own scheduled result;
only the schedule's message reached such a chat. Keeps
[ADR-0266](0266-schedules-set-by-asking.md).
</status>

## Context

- A member's private chat was a send destination only while their account reached a served group
  (ADR-0254). A member the owner added by Telegram id, who had not written in any group yet, did
  not, and a group switched off for them, or one they left, removed it the same way.
- Personal assistant reads only the member: their private chat can talk and set schedules without
  any group (`memberPrivate`, `memberAssistant`). The schedule's notice already reached the chat.
- The run itself reads as that member: their chat and the groups they reach, which is none here.
  The result can hold nothing from a chat the member may not read.

## Decision

1. A scheduled result goes to the member's private chat when it is the chat the schedule ran in
   and the chat is still theirs with Personal assistant on, also when they reach no served group
   (`sendsTo` in `src/stores/telegram-actions.ts`).
2. The same check stands at every step: the result's staging, the proposal, an approval, the run
   and the bot's last check before it sends. Turning Personal assistant off, pausing or removing
   the member, or turning their private chat off stops a result not yet sent.
3. Every other send to that chat (an approved post, a job report, a notice) still needs a served
   group, as before.

## Consequences

- A member's schedule works end to end from their first private message.
- The owner gets no "schedule result not sent" notice for such a run any more.
- Not changed: group schedules, the owner's schedules, and which chats count as served for any
  other send.
