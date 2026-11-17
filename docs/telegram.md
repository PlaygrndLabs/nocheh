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
3. Open the bot's private chat and send a message. Press **Find my ID** in
   **Settings › Telegram** to pick your own user ID, or run
   `./bin/nocheh discover-telegram` to see numeric chat/sender IDs.
   Discovery fsyncs observed updates and sends no messages. It runs only while
   assistant polling is disabled, so there is no competing poller.
4. Configure the owner DM, then apply the policy:

```sh
./bin/nocheh configure-telegram --owner-id 123456789
./bin/nocheh up
```

5. Add the bot to a group from your own Telegram account. Nocheh is on there at once
   ([groups](#groups)).

The ID is an example; use the discovered value. The ignored `.env` holds the
policy. To disable the assistant, set `TELEGRAM_ENABLED=false` and run `up`.
`configure-telegram` refuses `--group-id`: no setting lists groups any more, and
an old `TELEGRAM_GROUP_IDS` line in `.env` is ignored. Set your owner ID before you
add the bot to a group: an add Nocheh sees before then counts as someone else's,
and Nocheh leaves that group.

Nocheh keeps its own record of every chat and names each by an id of its own
([ADR-0252](adr/0252-chats-get-nochehs-own-ids.md)); a group Telegram upgrades to a
supergroup stays the same chat under its new Telegram id. A group is on while that
record says so, by any Telegram id it has had, and the owner's private chat is on
at each start ([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)). A selected
group is a group Nocheh is on in. `nocheh-telegram` and Hermes read which chats are
served from the app, not from `.env`, and stay quiet while they cannot.

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
the bar at the bottom of the screen. The people allowed in a group are kept while
Nocheh is off there or has left, for when it is on there again. Selected group titles,
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

Use discovered numeric user IDs. A group ID is checked by its shape only, so a
group that is off can have its people set before it is on. Each change applies to
the running services;
`--save-only` saves a batch for a later `./bin/nocheh config apply`.
Grant permits a participant to start a reply or tool-using turn in that group.
Deny overrides grant. Revoke removes either decision and returns that participant
to the owner-only default. Only the owner can administer these decisions.

Not allowed does not mean unheard. A message from a participant who is not
allowed is still archived, seen by the next group reply as context, learned by
that group's long-term memory and found by search and by recall from the owner's
private chat, labelled with the group. It stays out of one place only: the
owner's own notes (Memory › Assistant notes), together with the owner's reactions
to it, and a reply to it or a pin of it is reviewed without it. A message left
out stays out after a later grant; **Memory › Assistant notes** counts them.
Posts in a chat's own name, anonymous admins and other bots count as not
allowed. Nocheh's own messages never do once archived: a pin of one it learns
is reviewed with it, and a pin of its card, notice or reminder without it,
uncounted ([ADR-0257](adr/0257-learned-memory-names-its-source.md)).

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
Every archive search hit and every message the assistant opens names who wrote
it, where and when, in a tag Nocheh's code builds
([ADR-0261](adr/0261-recalled-facts-and-search-hits-name-their-source.md)):
`“Bob” (@bob) · this chat · 2026-11-03 14:12 UTC` in a group, and in the
owner's own chats the owner's Settings › Tasks time zone and, for someone the
owner renamed in People, `saved as “Brother”`. In a group the owner's own
messages read by the owner's Telegram name, with `by=owner`; a member never
reads another group, the owner's private chat, a People name, a topic name only
the owner typed (it reads `› a topic`) or the owner's time zone. Opening a
message also shows what it replies to, the message before that and the first
replies to it, each only where the reader may read it; a message in a forum
topic is no reply to the topic's opening.
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
share the decision. A hidden message also leaves the turns that quoted it: in a
group turn that carried it among the recent messages (or as the message the turn
replied to), its text becomes a notice naming its id, and that turn's searches
and other tool results, and the notes written from them, are withheld and
removed with it; the turn's own message and the answer already sent stay
([ADR-0261](adr/0261-recalled-facts-and-search-hits-name-their-source.md)).
**Undo hiding** restores future use. The original,
attachments, transcripts, and owner action history remain inspectable. A reply
already sent cannot be retracted, and an uncertain send remains uncertain until
its delivery receipt is resolved. Hiding records an owner decision,
not a Telegram deletion observation.

`nocheh-telegram` asks Telegram for exactly the update kinds Nocheh reads:
`message`, `edited_message`, `channel_post`, `edited_channel_post`,
`callback_query`, `message_reaction`, `message_reaction_count`, `my_chat_member`,
`chat_member` and `chat_join_request`. It checks on polling startup that its
Telegram library knows each of them. A group bot needs admin rights to receive
the reaction updates, and Telegram may delay anonymous count updates. Individual reactions
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

## Groups

Only the owner adds Nocheh to a group
([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)). Telegram tells the bot
when its own status in a chat changes (`my_chat_member`), with who added or
removed it. Nocheh acts only on a live update about a group's current Telegram
id that is newer than the group's last change; history and imports change
nothing. The first start of step 2b-2 marks where acting begins: adds and
removals already in the archive then are kept in the record only, and never
cause a leave, a line, a card or a change of state.

- **Your add.** When you add Nocheh to a group from your own account, it is on
  there at once. About 30 s later your private chat gets one card. A group with
  no project answer is then in a new project named after the group, and the
  card's buttons move it to one of up to three other projects, the ones
  updated last (**Move to …**), take it out of projects (**No project**), or
  turn Nocheh off there (**Turn off**). Only your own press in your private chat acts; anyone
  else's press is answered "Only the owner can do this." After a press the card
  shows the answer and has no buttons. Move and No project archive the card's
  project once no group is in it. A card that kept its buttons, because the
  edit failed, still works: each press acts again on the group as it is then.
  A group that already has a project answer keeps it and gets no card. A card
  that could not be sent is tried again only while the group is still on from
  your add and in that project; otherwise it never goes, and a project it left
  with no group is archived.
- **Anyone else's add.** A member, a stranger, another bot, an admin who
  remains anonymous or a channel: the group reads Leaving, Nocheh stays silent
  there, and about 30 s later it leaves. When the adder is a person you allowed
  in any group, you get one line naming them; when Telegram hid who added it,
  you get one line that says to turn off Remain anonymous and add Nocheh
  yourself, and Chats says the same; a stranger's add sends nothing. Each add
  keeps a record with no names or message text. When Telegram refuses the
  leave, the group reads Couldn’t leave and Nocheh stays silent there; the
  line, when there is one, says so. A leave Telegram does not answer is tried
  again after 1, 2, 4 and up to 60 minutes, with no limit, and the group stays
  silent meanwhile. One exception: a leave Telegram still answers with the
  group's upgrade after over an hour of tries ends as Couldn’t leave, like a
  refusal.
- **Caps.** You get at most one such line per group and ten such lines in all
  in 24 hours. A line over a cap is not sent.
- **Adds that change nothing.** An add to a group that is on changes nothing. A
  group Nocheh is already in that you never turned on stays Off and silent;
  Nocheh never leaves it on its own.
- **Removal.** When someone removes Nocheh from a group it was on in, you get
  one line, and the group reads Removed. That line always goes, once, and does
  not count toward the caps. Nocheh leaving makes the group Left.
- **An upgrade.** An upgrade is never an add. Telegram reports Nocheh joining
  the new supergroup, from whoever upgraded it. Within 10 minutes of the
  upgrade, that join to a group that is Off, Leaving or Couldn’t leave is an
  echo, even when it comes from you: the group keeps its state, and a group
  that is leaving is left under its new ID. Your own join still counts as an
  add in an Off group Nocheh had only just seen, in those 10 minutes, with no
  add on record: Nocheh's own add there was not recorded yet. The new
  supergroup's own add can also arrive before the upgrade messages. It then
  folds into the old chat when only its own add served it and it has no
  project yet, so the group keeps its state, project and people. Your add
  folded in turns on only a group Nocheh was not in (Left, Removed or Imported
  history) or had only just seen. Once the card made the new chat's project,
  the two stay apart, but the new one still takes the old one's Off, Couldn’t
  leave or Leaving, and who added Nocheh, when it is on only from your add
  within 10 minutes of the upgrade. Its card, if it had not gone yet, never
  goes. A Leaving group's leave moves to the new ID. Once the card told you
  Nocheh is on, Nocheh never leaves a group someone else added: the new chat
  stays on, and the old one reads Leaving, then Couldn’t leave after over an
  hour. A leave whose new ID never reaches Nocheh ends the same way.
- **A reset.** A data reset that keeps your setup brings back a group Nocheh
  was still leaving, with its topics, as Off. Nocheh stays in it, silent, until
  you turn it on or remove Nocheh in Telegram.

Turn Nocheh on or off in a group in **Chats** ([dashboard](dashboard.md)); the
switch applies at once. A group Nocheh left or was removed from has no switch:
add Nocheh there again yourself. Messages from a group Nocheh is leaving, has
left or could not leave are archived like any chat Nocheh does not serve: never
prepared, and never answered. The lines, the card and its buttons are the
owner's to edit in Settings › Assistant › Built-in instructions, under
**Groups: when someone adds Nocheh**. They name each group in quotes, with its
short ID.

`nocheh-telegram` leaves a group only when the app asks, through
`/internal/telegram/leave`. It refuses the owner's chat, a positive ID and any
chat that is on. Right before it leaves, it reads the served list again and
asks the app (`POST /internal/chats/leave`) whether the group is still waiting
to be left from that add, so a group you turned on or off, or that was added
again, meanwhile is not left. It keeps Telegram's answer to a leave for each
add and Telegram ID, so an upgraded group's new ID is asked on its own. Its
`/health` shows what `getMe` says the bot may
do: `can_join_groups`, `can_read_all_group_messages`, `supports_inline_queries`
and `can_connect_to_business`.

## Send records

Every request `nocheh-telegram` sends to Telegram leaves one record: each reply
chunk and retry, approved sends, approval cards and their edits, button answers,
refusals, notices and their edits, working reactions, leaving a group (listed
as "Leave a group"), and the bot's own setup calls. A request Nocheh's own checks refused, or a reply or approved send held
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
database's `chat_sends` table, adding the Nocheh chat the Telegram chat and
topic belong to ([ADR-0252](adr/0252-chats-get-nochehs-own-ids.md)). A record names
the topic by its thread as text, so a record from another chat app fits the same
shape. They are not journal entries, archive messages or delivery receipts, and
nothing reads them to decide a send.

**System › Sent to apps** lists them, newest first, with a Problems filter.
Failed and uncertain sends of the last day show on Health and in the owner's
problem notices. The notices leave out every send of the notice kind (problem
notices, task reminders and merged reminder messages, the notices that a
scheduled task's result or a job's report was not sent, import and inbox
messages), so a notice that cannot be sent never asks for another. A task
reminder that Telegram refused, or never confirmed after five tries, gets a
record of its own from the app (`reminder_refused`, `reminder_unconfirmed`), so
it shows on Health too ([ADR-0255](adr/0255-reminders-say-who-set-them.md)). A failed or uncertain try followed within 15
minutes by a sent one with the same chat, method and dispatch key, such as a
plain-text resend or a retry after a rate limit, shows as sent on a retry. It,
an unchanged edit, an expired button answer and a reaction the chat does not
allow are listed but never counted as problems. So is a leave Telegram answers
as gone (any 403, or "chat not found", "not a member" and the like): it reads
"Nocheh was no longer in the chat", and it also clears an earlier failed or
uncertain try of the same leave within 15 minutes. A failed or uncertain leave
try is also cleared once Nocheh leaves that group for the same add, at any
time, even when no later try went: Nocheh's own status update said it left,
or it left at the group's new ID after an upgrade. A cleared leave reads
"Nocheh left". A leave Telegram refuses stays a problem, unless Nocheh later
leaves that group for the same add. **Keep
delivery logs** in Settings › Privacy & data removes old records too. The
dashboard's own mini app menu button call does not pass the bot yet, so it has
no record ([ADR-0238](adr/0238-record-every-send-to-a-chat-app.md)).

## Send classes

Each message Nocheh sends carries a send class, set where the send is decided
and kept in the archived copy of the delivered message. It is separate from the
send record's kind, which does not change.

| Class | Sent as | Learned |
| --- | --- | --- |
| `reply` | an answer in the chat | yes |
| `follow_up` | a follow-up after an approved action | yes |
| `private_answer` | an Answer privately reply | yes |
| `job_report` | a background or machine job's report | yes |
| `scheduled_run` | a scheduled task's result | yes |
| `approved_post` | a post the owner approved | yes |
| `card` | an approval card or a fixed control reply | no |
| `card_update` | a card's settle, a button answer or a notice edit | no |
| `refusal` | the fixed reply to someone not allowed | no |
| `notice` | a problem, import or memory notice, a group's line about a job, or the card and lines about a group someone added Nocheh to | no |
| `reminder` | a task reminder | no |

A message that is not learned is still archived and searchable, and is context
when the owner replies to it; it never reaches the notes review, long-term memory
or interpretations, and System › Background work shows its learning step as
skipped ("Nocheh's own card, notice or reminder: kept, not learned"). The
owner can turn learning on for one message, and that yes overrides the class.
A route accepts only its own classes; an unknown class falls back to the
route's default and never stops the send. Leaving a group sends no message, but
runs under `notice` too, so nothing it returns could be learned. A message with no class, everything
sent before classes existed and the web chat's replies included, is learned
([ADR-0256](adr/0256-nochehs-own-messages-carry-a-send-class.md)).

A quote or a pin carries part or all of a message Nocheh sent. The owner's
quote or pin of a message Nocheh learns, other than its reply about a forward,
counts as Nocheh's in note labels. Whoever quotes or pins one of Nocheh's
messages, a card included, Nocheh's words are never learned as theirs: the
quote is left out of the message quoting it, and in long-term memory the pin
leaves only a fixed note that one of Nocheh's messages was pinned. The notes
review and interpretations still read a pinned message that Nocheh learns, as
Nocheh's, and a card the owner replies to stays context of that reply
([ADR-0256](adr/0256-nochehs-own-messages-carry-a-send-class.md)). A quote of a
card is labelled as a quote of someone else's message, without its words. Every
review and interpretation takes a pinned card out of the pin, and a pin of a
card with nothing else in it is neither reviewed nor interpreted. A message
from Nocheh's own account that the archive does not hold as Nocheh's, such as
Nocheh's own before its delivery is archived, or someone's forward of a
Nocheh message, is cut from a pin or quote the same way, and leaves the same
note. Nocheh tells its own account only by comparing the sender's ID with the
bot the update came to. Only Nocheh's own words are cut: another bot's message
that someone pins or quotes is learned as someone else's, and a message sent
through an inline bot, which its sender wrote, is labelled as sent through an
inline bot. The owner's quote of their own forward is a quote of whoever wrote
it, never the owner's words, and so is a quote of a message in another chat or
topic: Telegram shows only who first sent it, and in a forum topic it also points
the reply at the topic's first message, which the quote is not from. In the
owner's notes review a quote is judged by who wrote the message it answers, as a
pin is: another bot's message, which Telegram never sends to Nocheh, is cut out
and counted, and a quote of a message in another chat or topic stays only when
Nocheh holds that message and its sender is allowed there. A quote inside a
pinned message is judged the same way, by the message it quotes as Nocheh holds
the pinned message; Telegram sends a pinned message without its reply, so the
quote inside one Nocheh never got is cut, counted as a quote that could not be
traced. A Telegram Desktop export records a reply to another chat by that
chat's message id, which names a different message in this chat: an export
imported now is not linked to that message, and the owner's notes review never
judges a quote by the link an earlier import made. A pinned message's own
reply, such as a poll it answers in another chat, is never learned with the
pin. Any other
message one carries (the checklist that a "tasks done" or "tasks added" service
message reports on, a giveaway's or a suggested post's message, the poll an
option was added to, or one in a field Telegram adds later) is kept and
labelled: Nocheh tells such a message by its shape, never by a field's name,
cuts only its own words from it, and in the owner's notes review cuts one from
someone not allowed there, counted as kept out. Telegram sends such a message
with its quote but without its reply, so a quote inside one is traced through
that message as Nocheh holds it in the same chat, as a pinned message's quote
is: one quoting Nocheh's words is cut from everything learned, and so is one
Nocheh can't trace (the message never archived, or archived answering
nothing), counted as a quote that could not be traced, whoever it quoted. One
that keeps its reply to a message in another chat is judged in the owner's
notes review by that message, and cut and counted as not traced when Nocheh
holds no copy of the message carrying the quote. A
poll option someone added is judged by who added it there the same way, one
added in a chat's name never let in, and a deleted option's text is cut there,
except in the owner's private chat, where an option the owner deleted from
their own poll stays the owner's own; interpretations and long-term memory
keep them, labelled. Telegram names no one per checklist task,
and the owner can stop sharing a checklist after others added tasks, so a
checklist others can add tasks to, and any checklist edited, pinned, quoted or
forwarded, is labelled as someone else's words, never as the owner's own; in
the owner's private chat with Nocheh no one else can add tasks, so the owner's
own checklist there stays the owner's. A poll someone else added an option to,
a deleted option and a message carrying someone else's, or one with a quote,
are labelled the same way, and the owner's pin of such a message of their own
as a message holding someone else's words that the owner pinned. All of it is
still learned
([ADR-0257](adr/0257-learned-memory-names-its-source.md)).

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

Nocheh sends only to chats it serves: the owner's private chat and its topics,
the selected groups and their topics, and the private chats of people the owner
allowed in those groups. A send to a person's private chat always waits for the
owner's card. Any other destination, a chat Nocheh has no record of included, is
refused alike with `destination_not_served`, and the assistant is told the owner
can serve it on the Chats page. The app checks this when a send is proposed,
approved and started, and again whenever the bot asks before a message, so a
chat the owner stops serving gets nothing more; its card then says "Approved,
but not sent" and why. The card names the kind of chat in fixed words ("group",
"topic", "private chat with … (a person you allowed in group …)") and quotes
only the name; a name that reads like another chat's gets its project or the
short ID the Chats page shows after the name
([ADR-0254](adr/0254-sends-go-only-to-chats-nocheh-serves.md)).

## Task reminders

A task reminder goes to the owner's private chat at its time. One set by a
person the owner allowed, or by the owner in a group, starts with a line naming
who set it and where ("👤 Set by … in …"), and a task someone last wrote or
closed outside the owner's private chat and the dashboard says so too; a
person's notes come marked line by line. People's reminders due together in one
group arrive as one message, at most one message per group every 10 minutes,
with a line saying how many more are waiting; none is dropped. The owner's own
arrive at their time, one message each. A message from the owner in a group
that removes reminders set elsewhere sends the owner one notice. The lines are
editable in Settings › Assistant under **Reminder lines: who set it and where**
([ADR-0255](adr/0255-reminders-say-who-set-them.md)).

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
question that changed since (an archived project, an asking group that left it,
or no other of its groups left): the tap or `/start` gets a short fixed text and
no model runs. When the hour passes, the project is archived or the asking group
leaves it while the answer is being written, the answer is not sent and the
private chat gets that short text instead, once. Another group that leaves the
project only narrows the answer to the groups still in it; a later change never
widens it. An answer that ends in silence closes the same way,
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
([ADR-0249](adr/0249-answer-privately.md)).

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
