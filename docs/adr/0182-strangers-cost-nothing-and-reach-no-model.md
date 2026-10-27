# ADR-0182: Strangers cost nothing and reach no model

<status>
Accepted on 2026-10-27, after the owner started the bot from a second
Telegram account and saw its command menu. Extends
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md).
</status>

<context>
- The pinned Hermes Telegram adapter registers its native command menu for
  every private chat and group. Nocheh runs none of those commands: a slash
  command is ordinary text for the owner, and nobody else may use the bot.
  So anyone who opened the bot saw /status, /approve and the rest.
- Every live update is captured and then prepared. Preparation downloads
  files, extracts text and asks the secret-check model, whoever sent the
  message. A stranger could spend the owner's money and disk.
- Learning already refuses chats that are neither the owner's nor a selected
  group, but the owner's own turns read every archived source. The owner's
  search, and the conversation and identity lists of the owner read tool,
  could put a stranger's text or chosen name in front of the model.
- The fixed reply to people who aren't allowed covered selected groups only;
  a stranger in a private chat got silence.
</context>

<decision>
- The polling adapter clears the native command menu in the default, all
  private chats and all group chats scopes instead of filling it.
- A live Telegram update from a chat Nocheh doesn't serve (a private chat
  with anyone but the owner, or a group or channel the owner hasn't
  selected) is still archived as received. Its preparation closes as skipped
  with the reason `not_allowed`: no download, extraction or model call.
- Assistant turns cannot read such a source, the owner's included. The
  owner read tool leaves out those chats from conversations,
  conversation-context and telegram-identities unless an import, project,
  sharing rule or setting brought the chat in. The dashboard still shows
  them.
- A person's own message that Nocheh may not answer closes its dispatch with
  `not_allowed`, shown as "Not allowed" in Messages.
- Anyone but the owner who writes privately gets the owner-editable text
  `telegram.not_allowed_private`, without a model, at most once per UTC day
  per person; the runtime's receipt for that person and day enforces it.
</decision>

<consequences>
- A stranger can still make Nocheh store their text, but not make it spend,
  download, learn, or show that text to any model.
- Messages captured in a group before the owner selects it stay unprepared
  until then; afterwards the next refresh sweep, or the owner's own prepare
  from the dashboard, prepares them.
- Group members who aren't allowed in a selected group are unchanged: their
  messages are prepared and inform that group's next reply, as before.
</consequences>
