# ADR-0133: Group messages start a turn only when they address Nocheh

<status>
Accepted on 2026-10-11. Narrows the group behavior of
[ADR-0062](0062-owner-managed-telegram-group-participants.md): participant
permission still decides who may start a turn; addressing now also decides
which of their messages do.
</status>

<context>
Every message from a permitted participant in a selected group started a turn,
so Nocheh answered questions meant for the whole group or for another person.
The owner asked that it respond only when personally addressed.

The routed message that reaches Hermes keeps only the (possibly guarded) text:
the reply target and Telegram entities are dropped. Only the Hermes Telegram
adapter knows the bot's own @username and display name, loaded at connect.
</context>

<decision>

- `TELEGRAM_GROUP_REPLIES` is an owner setting: `addressed` (default) or
  `all`. `TELEGRAM_GROUP_NAMES` adds up to ten comma-separated names. Both
  appear in Settings › Telegram access and reach the `hermes` service.
- Telegram dispatch reads the captured original and adds `group_addressing`
  to a group turn's input: `direct` when the message replies to one of the
  bot's messages (not a forum topic's opening message) or tap-mentions it, and
  the @usernames named by its mention and `/command@name` entities.
- The Hermes gateway decides after the turn's capability and identity checks
  and before the chat lane: a group message is addressed when `direct` is set,
  the bot's @username is among the handles, or the routed text opens with the
  bot's display name or a configured name as a whole word. Otherwise the turn
  closes as `suppressed` with `not_addressed`, and no model call is made.
- Owner private messages are never gated. Capture, preparation, archive and
  Honcho ingestion of group messages do not depend on addressing.

</decision>

<consequences>
- An unaddressed group message is archived and visible in Monitoring as "did
  not address Nocheh"; it no longer uses a reply slot or the model.
- Unaddressed messages are not in the group's Hermes native conversation
  history. A turn that refers to earlier chatter relies on the group's archive
  search and Honcho context for it.
- The decision uses the bot identity loaded when Hermes connects; a BotFather
  rename takes effect after Hermes restarts. Replies to the bot do not depend
  on that identity.
</consequences>
