# ADR-0158: Approve and Reject buttons in Telegram

<status>
Accepted on 2026-10-19 during release test 2 on the owner's installation. The
owner asked Nocheh for a group message; Nocheh drafted it and told the owner
to approve it elsewhere. The owner asked to approve it in chat with a button
under the message, in private chats and in groups wherever a button action is
needed.
</status>

<context>
A pending Telegram message or shell, browser or MCP operation could be decided
in the dashboard Inbox or with `/approve <id>` and `/deny <id>` in the owner's
private chat. Both need the full action ID. Telegram inline buttons send a
`callback_query` update; Nocheh already captures it and ignored it. Its data
holds at most 64 bytes, and Telegram only delivers data from a button the bot
itself sent.
</context>

<decision>
- When a turn or a scheduled result creates an action that waits for the
  owner, Nocheh sends a card with the exact message and destination, or the
  exact operation arguments, and two buttons. Each button carries a marker,
  the choice, the first 40 hex characters of the action ID and the first 16 of
  the fingerprint of its exact content (58 bytes).
- The card goes in the group or topic where the request was made when the
  action stays in that group, so nothing reaches an audience that could not
  see the turn. Every other card goes to the owner's private chat. Operation
  arguments longer than the Telegram review limit get no card.
- A press is handled in the reply workflow before any turn starts and is
  recorded as `approval_button`. Only a press by the owner's Telegram account
  decides, through the same decision records as the dashboard and commands,
  with the press as the decision source and its update as the operation ID, so
  a redelivered press decides once. A press from anyone else, for changed
  content, or on a decided action changes nothing and gets a short answer.
- After any decision, from a button, a command or the Inbox, the card is
  edited to show the outcome and loses its buttons. Hermes keeps a send
  receipt per card, never sends a second card for one action, and edits only
  a card it sent, in the chat it sent it to.
- Offering, editing and answering are best effort: when Telegram or Hermes is
  unavailable the action still waits in the Inbox.
</decision>

<consequences>
- The owner approves or rejects with one tap where the request was made.
- Group members see a pending card for an action in their own group but
  cannot decide it.
- The model is told whether buttons were sent, so its reply points to them.
- Card and button texts are fixed in code like the Telegram command replies;
  making them editable is open in `TASK.md`.
</consequences>
