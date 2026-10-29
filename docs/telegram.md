# Telegram setup and assistant acceptance

The native Hermes Telegram adapter is active locally with the configured owner and
selected groups. Owner-DM and selected-group replies have passed; the remaining
[release checks](release-acceptance.md) are pending. New installations default to
disabled until a token, owner ID and explicit policy are configured. No VPS is needed.

1. Create or select your bot in [BotFather](https://t.me/BotFather).
2. Set `TELEGRAM_BOT_TOKEN` in `.env`, then run `./bin/nocheh up`. Keep it out of chat,
   command-line arguments and Git.
3. Open the bot's private chat and send a message. Add it to any group you want to
   select. Run `./bin/nocheh discover-telegram` to see numeric chat/sender IDs.
   Discovery fsyncs observed updates and sends no messages. It runs only while
   assistant polling is disabled, so there is no competing poller.
4. Configure the owner DM and selected groups, then apply the policy:

```sh
./bin/nocheh configure-telegram --owner-id 123456789 --group-id=-1001234567890
./bin/nocheh up
```

Omit `--group-id` for DM only, or repeat it to select multiple groups. These IDs
are examples; use the discovered values. The ignored `.env`
holds the policy. To disable the assistant, set `TELEGRAM_ENABLED=false` and run `up`.

Only the owner may address Nocheh in a selected group by default. The owner can
manage individual participant IDs in **Chats**, by opening the group, then Save in
the bar at the bottom of the screen. Selected group titles,
visible administrators, and observed senders appear by name and numeric ID;
each listed person has Denied or Allowed access. Denied is the default, whether
there is no individual grant or an explicit saved denial. The Bot API does not
list every group member,
so add an ID manually when a person has not appeared in those sources.
The same controls are available in the CLI:

```sh
./bin/nocheh group-access list
./bin/nocheh group-access grant -1001234567890 987654321
./bin/nocheh group-access deny -1001234567890 987654321
./bin/nocheh group-access revoke -1001234567890 987654321
```

Use discovered numeric user IDs. Each change applies to the running services;
`--save-only` saves a batch for a later `./bin/nocheh config apply`.
Grant permits a participant to start a reply or tool-using turn in that group.
Deny overrides grant. Revoke removes either decision and returns that participant
to the owner-only default. Only the owner can administer these decisions.

For proactive group conversation, disable the bot's group privacy mode in
BotFather or give it the appropriate group administrator role. Telegram otherwise
delivers a limited set of group messages. The archive can preserve only updates
the Bot API supplies; use Desktop imports for available history. See Telegram's
[message visibility rules](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
Large files that Telegram cannot supply remain visibly failed artifacts; supplied
Desktop media can be imported separately.

Each selected group/topic has its own native Hermes memory and history. Memory
access supports isolated, approved and filtered derived sharing under ADR-0030;
the owner DM may search the complete archive and registered native memory. Unselected
chats and participants without a group grant cannot trigger the assistant. Bot
senders, edits and historical replay do not trigger new replies.
Normal group chatter can produce intentional silence. Voice, audio and round
video notes are archived with their original bytes and an extraction status
saying transcription is not available; they never hold a reply. Media bytes are downloaded
by the archive worker; the assistant does not repeat native media downloads or
run a shared sticker-description cache. Photos/documents remain available as
archived files and captions; automatic visual interpretation is not enabled.

In an ordinary bot chat, Telegram's Bot API does not report when a user deletes
a message. A voice note that Nocheh already captured remains source evidence and
may still be answered after it disappears from Telegram. Sending
a second voice note creates a separate request; it does not cancel the first.
The Bot API's `deleted_business_messages` update applies to connected business
accounts, not ordinary bot chats.

In an original-only Archive, open the exact captured message and choose **Retire
from Nocheh** to stop future agent use and learning. This works for text, voice,
media, edits, and assistant replies; all observed edits of one Telegram message
share the decision. **Undo retirement** restores future use. The original,
attachments, transcripts, and owner action history remain inspectable. A reply
already sent cannot be retracted, and an uncertain send remains uncertain until
its delivery receipt is resolved. The Archive action records an owner decision,
not a Telegram deletion observation.

The pinned native adapter explicitly requests all Telegram update types, which
include `message_reaction` and `message_reaction_count`; Nocheh checks that
contract on polling startup. A group bot needs admin rights to receive these
updates, and Telegram may delay anonymous count updates. Individual reactions
are tracked by target and actor; anonymous counts are separate. Changes and
removals invalidate stale inferred meaning without sending a new reply to an old
message. If no update is delivered, Nocheh cannot infer a reaction change.

## Mini app

The mini app shows Home, Inbox and Tasks inside Telegram. It opens from the
button next to the message box in the owner's private chat with Nocheh. Only
the owner's Telegram account gets in: every request carries the launch data
Telegram signs, and the mini app checks that signature with Telegram's public
key and the bot's public ID. Settings and System stay on the dashboard.

On top of that, the mini app asks for the owner's Nocheh password, the same one
as the dashboard ([sign-in](dashboard.md#sign-in)); until the dashboard has
created it, the mini app stays locked. Each phone signs in once and stays
signed in until it signs out from Home or goes 30 days without opening the
mini app. A new password, or Sign out everywhere else in Settings › Privacy &
data, signs every phone out at once.

The mini app runs as its own small service with no credentials. A Cloudflare
tunnel connects it, and nothing else, to an https address on the owner's own
domain; the tunnel only opens an outgoing connection, so no port is opened on
the computer.

To turn it on:

1. In Cloudflare, open Zero Trust, then Networks, then Tunnels, and create a
   tunnel of type Cloudflared. Copy its token; skip the install step.
2. Add a public hostname to the tunnel, for example `nocheh` on your domain,
   with service type HTTP and URL `nocheh-miniapp:8788`.
3. In the dashboard, open Settings, then Telegram. Under Mini app, enter the
   address (such as `https://nocheh.example.com`) and paste the tunnel token.
   Save, then Apply.
4. The mini app asks for the dashboard's password once on each phone.

Apply starts the mini app and the tunnel and puts the mini app on the menu
button of the owner's private chat. Clearing both fields and applying stops
them and puts the usual menu button back. An installation that is not run with
`make dev` builds the mini app image once with `./bin/nocheh build` after Save and before the
first Apply.

## External action approval

The assistant may propose an external Telegram message. It cannot approve one.
In the owner's private DM:

```text
/actions
/action FULL_ACTION_ID
/approve FULL_ACTION_ID
/deny FULL_ACTION_ID
```

`/action` shows the destination and exact requested text. A live typed owner DM,
the authenticated owner's Activity page or `./bin/nocheh approvals` can approve.
Group messages, imported history, callbacks and transcripts cannot approve or
alter settings. Controlled shell, browser and public HTTPS MCP requests also use
exact proposals and bounded revocable permissions; see ADR-0029. Uncertain
delivery remains ambiguous; it is not automatically resent.

## Validation

`./bin/nocheh test` exercises scope, native memory/session isolation, attachment
provenance and retry behavior, immutable action requests and owner-only approval.
The synthetic native memory rehearsal sends no Telegram messages:

```sh
docker compose exec -T hermes python -m services.hermes.verify_assistant
```

Before release, verify actual owner DM replies, selected-group replies and silence,
group-private retrieval boundaries, voice note persistence, approved action
delivery, native reconnect and restart recovery. Credentials are present; those
remaining checks need actual Telegram traffic and saved evidence. Production
release cannot be marked complete on offline tests alone. See
[the test inputs and evidence requirements](release-acceptance.md).
