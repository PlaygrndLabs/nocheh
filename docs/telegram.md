# Telegram setup and assistant acceptance

Nocheh's own Telegram service, `nocheh-telegram`, is the bot: it is the only part
that holds the bot token, polls Telegram and sends to it. The brain (Hermes today)
only writes the replies ([ADR-0235](adr/0235-nocheh-owns-the-telegram-bot.md)). It is
active locally with the configured owner and selected groups. Owner-DM and selected-group replies have passed; the remaining
[release checks](release-acceptance.md) are pending. New installations default to
disabled until a token, owner ID and explicit policy are configured. No VPS is needed.

1. Create or select your bot in [BotFather](https://t.me/BotFather).
2. Set `TELEGRAM_BOT_TOKEN` in `.env`, then run `./bin/nocheh up`. Keep it out of chat,
   command-line arguments and Git.
3. Open the bot's private chat and send a message. Add it to any group you want to
   select. Press **Find my ID** in **Settings › Telegram** to pick your own user ID, or run
   `./bin/nocheh discover-telegram` to see numeric chat/sender IDs.
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

Once your user ID is saved, the dashboard shows it read-only; it changes only from
the command line ([ADR-0244](adr/0244-owner-defaults-posts-and-machine-reports-stay-private.md)):

```sh
./bin/nocheh config set TELEGRAM_OWNER_ID 123456789
./bin/nocheh config apply
```

`config set` refuses an ID that is allowed or denied as a person in a group, and
`configure-telegram` checks the whole policy before it writes `.env`.

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
A file over Telegram's 20 MB bot download limit is archived as a reference only
and does not hold the reply; supplied
Desktop media can be imported separately.

Each selected group/topic keeps its own Hermes notes and conversation history; by default a
group's topics share Honcho recall and archive search (**Topic memory** in
Settings › Telegram can keep each topic separate). Memory
access supports isolated, approved and filtered derived sharing under ADR-0030;
the owner DM may search registered native memory and the archive, except chats Nocheh does not serve. Unselected
chats and participants without a group grant cannot start a turn. Someone who
addresses Nocheh in a selected group without a grant, or anyone else who writes
privately (at most once a UTC day), gets the owner's fixed reply without a model;
messages from chats Nocheh does not serve are archived but never prepared. Bot
senders, edits and historical replay do not trigger new replies.
In a group, a message starts a turn only when it addresses Nocheh: a reply to
one of its messages, its @username, or one of its names opening the message
(**Names that call Nocheh**). Other messages reach the next reply as context;
**When Nocheh answers** can answer every message instead. Voice, audio and round
video notes keep their original bytes and are transcribed before their reply
(see [provider.md](provider.md#voice-notes)). Media bytes are downloaded
by the preparation workflow; the assistant does not repeat native media downloads or
run a shared sticker-description cache. Photos and documents remain available as
archived files and captions, and their text is read before the reply
([provider.md](provider.md#images)).

In an ordinary bot chat, Telegram's Bot API does not report when a user deletes
a message. A voice note that Nocheh already captured remains source evidence and
may still be answered after it disappears from Telegram. Sending
a second voice note creates a separate request; it does not cancel the first.
The Bot API's `deleted_business_messages` update applies to connected business
accounts, not ordinary bot chats.

In **Messages**, open the exact captured message and choose **Hide from
assistant** to stop future agent use and learning. This works for text, voice,
media, edits, and assistant replies; all observed edits of one Telegram message
share the decision. **Undo hiding** restores future use. The original,
attachments, transcripts, and owner action history remain inspectable. A reply
already sent cannot be retracted, and an uncertain send remains uncertain until
its delivery receipt is resolved. Hiding records an owner decision,
not a Telegram deletion observation.

The pinned native adapter explicitly requests all Telegram update types, which
include `message_reaction` and `message_reaction_count`; Nocheh checks that
contract on polling startup. A group bot needs admin rights to receive these
updates, and Telegram may delay anonymous count updates. Individual reactions
are tracked by target and actor; anonymous counts are separate. Changes and
removals invalidate stale inferred meaning without sending a new reply to an old
message. If no update is delivered, Nocheh cannot infer a reaction change.

While Nocheh works on a message, the bot shows "typing…" in its chat or topic
(**Show typing while working** turns it off) and reacts to it with working
reactions: 👀 while it works, then 👍 once the reply is
sent or 👎 when the turn failed. A turn that ends in silence, is cancelled, or
whose delivery is uncertain clears the 👀; a retried turn sets it again. The reactions follow the same rules
as "typing…": only for a turn that will write an answer, only on that exact
message, under the space's current permission, and not recorded as a delivery
(each still leaves a [send record](#send-records)).
Telegram sends no update for a bot's own reactions, and a group that limits its
reactions may refuse them, which only costs the reaction. **React while
working** in Settings › Telegram turns them off.

## Send records

Every request `nocheh-telegram` sends to Telegram leaves one record: each reply
chunk and retry, approved sends, approval cards and their edits, button answers,
refusals, notices and their edits, working reactions, and the bot's own setup
calls. A request Nocheh's own checks refused, or a reply or approved send held
back whole because Telegram asked the bot to wait, is recorded as not sent.
"typing…" is never recorded, not even when it fails. Reads (`get…` calls and
file downloads) are not recorded, and neither is a request the outbound journal
answers without sending.

A record holds the kind of send, the Bot API method, the chat and topic, the
message ID, a reaction's emoji, the outcome (sent, failed, uncertain or not
sent), the HTTP status, a reason code such as `bot_blocked` or
`reaction_not_allowed`, the dispatch key it ran under and how long it took. It
never holds text, buttons, links, the token or Telegram's own error wording.
Records go to `spool/sends`, and `nocheh-app` moves them into the control
database's `chat_sends` table. They are not journal entries, archive messages
or delivery receipts, and nothing reads them to decide a send.

**System › Sent to apps** lists them, newest first, with a Problems filter.
Failed and uncertain sends of the last day show on Health and in the owner's
problem notices. The notices leave out every send of the notice kind (problem
notices, task reminders, import and inbox messages), so a notice that cannot be
sent never asks for another. A failed or uncertain try followed within 15
minutes by a sent one with the same chat, method and dispatch key, such as a
plain-text resend or a retry after a rate limit, shows as sent on a retry. It,
an unchanged edit, an expired button answer and a reaction the chat does not
allow are listed but never counted as problems. **Keep
delivery logs** in Settings › Privacy & data removes old records too. The
dashboard's own mini app menu button call does not pass the bot yet, so it has
no record ([ADR-0238](adr/0238-record-every-send-to-a-chat-app.md)).

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
the dashboard Inbox, `./bin/nocheh approvals`, or the owner's Approve press on
the card Nocheh sends to the owner's private chat can approve. A group request for
a post in that same group (that same topic when **Topic memory** keeps topics separate) needs none; a card for another group or topic goes to the person
who asked when they are allowed in both. Other group messages, imported history
and transcripts cannot approve or alter settings. Controlled shell, browser and public HTTPS MCP requests also use
exact proposals and bounded revocable permissions; see ADR-0029. Uncertain
delivery remains ambiguous; it is not automatically resent.

## Answer privately

A group answer uses only that group. When Nocheh answers the owner's own
question in a group or topic whose project has at least one other served group,
the answer's last part carries one button, **🔒 Answer privately**. It never
appears under a member's question, a fixed reply, a silent answer, a reply in a
private chat, a job's report or a follow-up, or in a group whose project is
archived or has no other served group.

Only the person who asked can use it. Anyone else's tap gets a short popup and
nothing runs. The owner's tap freezes the groups the answer may read, the
asking group and the project's other served groups, and opens the owner's
private chat with the bot through `https://t.me/<bot username>?start=<id>`.
Telegram then sends `/start <id>`, or shows **Start** for the owner to press.
Only that exact text in the owner's private chat opens the answer; a plain
`/start` is an ordinary message.

The private answer replies to `/start` there, from the question's text, voice
transcripts and extracted file text and the groups frozen at the tap. It only
reads: it searches, reads and pages the archive, searches long-term memory by
plain search and lists or reads tasks, and cannot post, change a task, start or
check a job or ask for an action. It
uses the project's role and skills, else the groups default, never the private
chat's, and gets only the sharing and grants that reach the asking group. Each
private answer is its own conversation, titled `Private answer`.

A button lasts a day, a tap waits ten minutes for `/start`, and an answer has
an hour to arrive. Too late, already answered, someone else's, or a project or
question that changed since: the tap or `/start` gets a short fixed text and
no model runs. When the hour passes or the project's groups change while the
answer is being written, the answer is not sent and the private chat gets that
short text instead, once. An answer that ends in silence closes the same way,
without a notice, so a later tap or `/start` is told it expired, never that it
was already answered. A group reply that the bot does not send takes its button's
record with it. The button's label, its popups and those texts are one
**Answer privately button and notices** setting in Settings › Assistant, beside
**Private answers** (its reply rules) and **Private answer’s first line**.

Every send it takes is recorded like any other
([send records](#send-records)): the group reply, each tap's popup as a button
answer without its link, and the private answer. A project's page in
Memory › Projects lists its buttons with where each was asked, the groups its
answer could read and what became of it
([ADR-0248](adr/0248-answer-privately.md)).

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
