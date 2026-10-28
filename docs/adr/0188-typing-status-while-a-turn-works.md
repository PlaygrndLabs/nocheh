# ADR-0188: Telegram shows typing while a turn works

<status>
Accepted on 2026-10-28, after the owner asked: "can when agent is working
show typing status or style for bot?"
</status>

<context>
- A reply takes from a few seconds to over a minute (memory recall, tools,
  provider calls). Telegram showed nothing in that time, so a message looked
  ignored until the answer landed.
- The pinned Hermes Telegram adapter can renew Telegram's "typing…" status
  (`sendChatAction`) itself, but Nocheh builds it with
  `typing_indicator=False`, and the committed adapter replaces the native
  `handle_message` that would start it. Turning the native option on would
  also re-arm typing after every sent chunk, including the final one, so the
  status would show again for five seconds after the answer.
- Every outbound Bot API request went through the durable outbound journal,
  which also records an archive event. Its key is the dispatch and the exact
  parameters, so a second identical chat action in the same turn would be
  answered from the journal instead of being sent, and each one would add
  archive records.
</context>

<decision>
- The committed adapter starts its own typing task when a committed turn
  enters `handle_message`, and stops it, waiting for it to finish, as soon as
  the model answer is ready and before delivery begins, or when the turn
  fails or is cancelled. It renews the status every four seconds; Telegram
  shows each one for about five.
- Typing runs only for a turn that will write an answer: dispatch already
  returns before a turn for someone Nocheh doesn't serve and for a group
  message that did not address it, and a fixed control reply skips typing.
- Each chat action is sent under the same outbound check as the reply: the
  turn's chat and exact topic, the current space permission and the turn's
  cancellation. A chat action without a bound check is refused before any
  request.
- Chat actions skip the outbound journal. They carry no content, expire by
  themselves and have no effect to reconcile, so they are neither journaled
  nor recorded as delivery evidence.
- The owner setting `TELEGRAM_TYPING` (`true` by default) is "Show typing
  while working" in Settings › Telegram. It reaches the Hermes service and
  takes effect on Apply.
</decision>

<consequences>
- A long turn costs one small Bot API call and one permission check every four
  seconds, and no stored record.
- The secret check of a new message runs before the turn starts, so those
  first seconds show no typing yet.
- A turn that ends in intentional silence showed typing while it worked; with
  "Every message" group replies that can be any group message.
- The native typing option stays off, so no status is shown after the final
  reply.
</consequences>
