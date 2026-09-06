# Telegram setup and assistant acceptance

Phase 6 is under validation. Telegram stays disabled until a token, owner ID and
explicit conversation policy are configured. No VPS is needed.

1. Create or select your bot in [BotFather](https://t.me/BotFather).
2. Put its token in `data/local/secrets/telegram_bot_token`. Keep it out of chat,
   command-line arguments and Git.
3. Open the bot's private chat and send a message. Add it to any group you want to
   select. Run `./scripts/nocheh discover-telegram` to see numeric chat/sender IDs.
   Discovery fsyncs observed updates and sends no messages. It runs only while
   assistant polling is disabled, so there is no competing poller.
4. Configure the owner DM and selected groups, then apply the policy:

```sh
./scripts/nocheh configure-telegram --owner-id 123456789 --group-id=-1001234567890
./scripts/nocheh up
```

Omit `--group-id` for DM only, or repeat it to select multiple groups. These IDs
are examples; use the discovered values. The ignored `data/local/assistant.json`
holds the policy. To disable the assistant, set `enabled` to `false` and run `up`.

For proactive group conversation, disable the bot's group privacy mode in
BotFather or give it the appropriate group administrator role. Telegram otherwise
delivers a limited set of group messages. The archive can preserve only updates
the Bot API supplies; use Desktop imports for available history. See Telegram's
[message visibility rules](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
Large files that Telegram cannot supply remain visibly failed artifacts; supplied
Desktop media can be imported separately.

Each selected group has its own native Hermes memory and history. The owner DM
may search the complete Nocheh archive. Other chats are captured but cannot trigger
the assistant. Bot senders, edits and historical replay do not trigger new replies.
Normal group chatter can produce intentional silence. Voice transcripts are
derived records, never replacements for original audio or message payloads.

## External action approval

The assistant may propose an external Telegram message. It cannot approve one.
In the owner's private DM:

```text
/actions
/action FULL_ACTION_ID
/approve FULL_ACTION_ID
/deny FULL_ACTION_ID
```

`/action` shows the destination and exact requested text. Only a live typed owner
DM can approve. Group messages, imported history, callbacks and transcripts cannot
approve or alter settings. Other external integrations are unavailable. Uncertain
delivery remains ambiguous; it is not automatically resent.

## Validation

`./scripts/nocheh test` exercises scope, native memory/session isolation, transcript
provenance and retry behavior, immutable action requests and owner-only approval.
The synthetic native memory rehearsal sends no Telegram messages:

```sh
docker compose --env-file data/local/compose.env exec -T hermes python -m integrations.hermes.verify_assistant
```

Before release, verify actual owner DM replies, selected-group replies and silence,
group-private retrieval boundaries, voice transcript persistence, approved action
delivery, native reconnect and restart recovery. Live Telegram checks are pending
while credentials are absent. Phase 6 must not be marked complete on offline tests
alone. See [the implementation decision](adr/0021-scoped-native-assistant-processes.md).
