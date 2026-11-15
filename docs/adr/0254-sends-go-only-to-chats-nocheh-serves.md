# ADR-0254: Sends go only to chats Nocheh serves

<status>
Accepted on 2026-11-15, as the sends half of the third set of fixes from the
review of how text from outside reaches Nocheh (risk 3, "Approved sends can go
to any chat"). The owner approved it on 2026-11-14 ("all yes") with its wording:
Nocheh sends only to chats it knows, the owner's private chat, the selected
groups and their topics, and the private chats of people the owner allowed in
those groups; the card names the chat type in fixed words and quotes the name;
nothing that works today is lost. Amends
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md): the
private chat of a person the owner allowed in a selected group is a send
destination, always behind the owner's card. Builds on
[ADR-0250](0250-cards-and-forwards-say-whose-words-they-are.md) (names on cards)
and [ADR-0252](0252-chats-get-nochehs-own-ids.md) (the chat directory), and
narrows ADR-0252's "a destination is a chat the directory knows" to a chat
Nocheh serves. Keeps [ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md),
[ADR-0161](0161-requesters-review-their-own-cross-group-messages.md) and
[ADR-0092](0092-exact-topic-action-destinations.md). The reminders half is
[ADR-0255](0255-reminders-say-who-set-them.md).
</status>

<context>
- A send's destination was accepted when the chat directory knew it. Every chat
  Nocheh ever captured has a row, a stranger's private chat and a group the
  owner never selected included; such rows are off, but nothing on the send
  path read that. A turn steered by text it read could ask for a message to
  such a chat, and one Approve sent it.
- The card named a group as just its quoted title, and a person's private
  chat as "a Telegram group" with a link that did not work. A title can be
  written to read like the card's own words or another chat's name.
- The card showed the message as typed, characters a reader cannot see
  included, and had no length check.
- A send whose chat could no longer be reached after its approval waited for a
  chat that never came back, and a scheduled result or a job report held back
  for its chat told the owner nothing.
</context>

<decision>

## Which chats are served

- `servedDestination(policy, id, directory)` (`src/destinations.ts`) is the one
  rule. In order: the owner's private chat or one of its topics is `owner`; a
  served group or one of its topics is `group` (a topic follows its group); the
  private chat of a person, not the owner, whose account is allowed in a served
  group is `person`, with the served groups they are allowed in, sorted.
  Anything else, a stranger's private chat, a group that is not selected or is
  turned off and its topics, a private chat with no account, and an id the
  directory does not know, is not served.
- It reads the chat directory and the access lists only, never an id's shape
  (the format gate stays as it is). `allowedIn` answers whether a person is
  granted in a group under any of its Telegram ids and denied under none;
  `allowedAccounts` maps every allowed person's account to their served groups,
  kept per directory while the policy object is the same. `accountIdFor` keeps
  the ids it already hashed.
- A person's private chat is never one of the groups a member may review a
  send for, so only the owner approves a send there, and the owner freedom
  setting never approves one: it covers the owner's own chat only.

## Where it is checked

- **Proposal** (`/v1/action-requests`) and **system sends** (job reports,
  machine lines, memory follow-ups, schedule results): a destination that is
  not served is refused with 403 `destination_not_served`. An unknown id and
  an unserved one answer alike, so asking teaches nothing about which chats
  exist. Only an empty text keeps 400 `invalid_action`.
- **Approval**: approving a card whose chat Nocheh stopped serving while it
  waited keeps the decision, closes the send as cancelled with
  `destination_not_served`, and returns its id, so the dashboard and `/approve`
  settle the card.
- **Run**: an approved send whose chat is no longer served, or no longer known,
  is cancelled with `destination_not_served` before it starts, instead of
  waiting for a chat that never comes back.
- **Delivery**: `authorizeDelivery`, which the bot asks before the send and
  again before each physical message, refuses a chat that is not served now;
  the send is then stored as rejected with `destination_not_served`. This is
  the last word. The bot gets no copy of the rule: it already asks the app
  before and during each send.
- A security rule that refuses an approved send at its start stores
  `security_start_denied`, so the card reads as a changed setting, not as the
  owner's own Reject.

## What the model and the owner are told

- The data tool answers a refused proposal with `destination_not_served` and a
  fixed note: nothing was sent and no card was made; Nocheh posts only in the
  owner's private chat and its topics, the owner's selected groups and their
  topics, and the private chats of people the owner allowed in those groups;
  tell the asker in one sentence; the owner can select the group, or allow the
  person in a selected group, on the dashboard Chats page. The broker relays
  that code from `/v1/action-requests`; every other code stays opaque. The
  tool's description and the destinations list say the same.
- A send closed unsent says so on its card, in the answer to the press and to
  `/approve`: `not_sent` ("🚫 Approved, but not sent: {reason}") with
  `reason_not_served`, or `reason_changed` for a changed context or a refused
  delivery. A Reject the owner pressed still reads as rejected. A cancelled or
  refused send settles its card instead of staying at "Sending now".
- The owner gets one notice in the private chat, in the owner's editable words,
  when a scheduled task's result is not sent (its chat is not served, keyed per
  run; or the settings changed while it ran, `reason_settings_changed`), when a
  schedule cannot run because its chat is not served (keyed by schedule, chat
  and guard epoch, so it repeats only after a settings change), and when a
  job's report cannot reach the chat it was asked in (not for a job asked in
  the owner's chat, which is always served). Such a job ends
  `job_report_not_delivered` instead of failing every tick. A notice is cut to
  Telegram's limit at a whole character; one that fails shows in System ›
  Health and never causes another.

## The card

- The destination names the kind of chat in fixed, owner-editable words
  (`telegram.approval_texts`): `private_chat`, `group_chat` ("group {name}"),
  the `topic` line with `topic_name` ("topic {name}"), `unnamed_topic` or
  `general_topic`, and for a person `person_chat` ("private chat with {name} (a
  person you allowed in {group})"), `person_chat_more` (with "{count} more"),
  or `person_chat_other` when no served group allows them any more.
  `unknown_chat` names a chat the directory no longer knows, and `not_served`
  ("(not served now)") follows a group or topic that is not served, also on
  "Asked in" lines.
- Only a name someone chose is quoted, inside quotes and direction isolates
  that code adds (`quotedName`), and it sits in a link (the group's latest
  message, the topic, or a person's Telegram profile by a valid public
  username) or in bold. `labelName` makes a name safe to quote: an ellipsis
  becomes three dots, more than three marks on one letter are written out,
  quote, bracket and angle look-alikes (by Unicode category and by UTS #39
  prototype) become plain `'`, `[`, `]`, `<`, `>`, and then ADR-0250's
  one-line, written-out, whole-character cut applies.
- A person is named by their private chat's title, then their Telegram name,
  then their @username, else `unnamed_person` with a short id.
- A name whose key (`nameKey`: the UTS #39 skeleton, lower-cased, skeleton
  again) equals another served group's, an allowed person's or the owner's
  chat's gets a suffix: on a card in the owner's private chat, a group's
  project (`name_project`); otherwise the chat's short id (`name_id`,
  "{name} (…{id})"). A project's name never shows on a card in a group. The
  short id, `chatShortId`, is a hash of the chat's id (four hex characters of
  `sha256(['chat-label-v1', id])`), never a piece of it; the dashboard's Chats
  page shows the same one after a group's or a person's name, and a person's
  @username with its link.
- The message on the card shows its hidden characters written out
  (`visible`), so the owner approves what will be sent. A card too long with a
  person's full line names the person alone; one still too long goes to the
  existing "review in the dashboard Inbox" path. A decided card, which has no
  buttons, is cut to fit instead.
- A saved approval or reminder line that drops a value Nocheh fills in, such
  as `{name}` or `{reason}`, is refused (`prompt_placeholder_missing`); such a
  line already stored reads as its default, alone.

</decision>

<alternatives>
- **A second copy of the rule in the bot.** Not built: the bot already asks the
  app's `authorizeDelivery` before the send and for each message, so the app's
  answer is the last word and one rule cannot drift from another.
- **Refusing a person's private chat until members exist.** Rejected: it would
  break "tell Bob privately" for a person the owner allowed, which works today.
- **Refusing a message whose text reorders the line around it.** Rejected: it
  would refuse sends that work today; the card shows every hidden character.
- **A separate refusal code for a security rule at the start.** Rejected:
  `security_start_denied` is already mapped to a reason the owner can read.
</alternatives>

<consequences>
- A message to a stranger's private chat or to a group the owner did not
  select is refused with no card, and the asker is told the chat is not one
  Nocheh serves. Selecting the group, or allowing the person in a selected
  group, on the Chats page serves it. An unknown destination answers 403
  `destination_not_served` where it answered 400 `invalid_action`.
- "Tell Bob privately" keeps working when Bob is allowed in a selected group,
  always through the owner's card. Posts to the same group, to another group,
  to the owner's chat and its topics, job reports, machine lines, memory
  follow-ups and schedules keep working wherever their chat is served.
- Cards read "group “Family” › topic “Plans”" where they read "“Family” ›
  Plans"; an owner-edited `topic` line is still honoured.
- Every send check reads the chat directory as it is now (`currentChats`), so
  deselecting a group or removing a person stops a send that waits.
- **Residuals:**
  - Two names that read alike but whose keys differ (look-alikes UTS #39 does
    not list) get no suffix; the quotes, the fixed words and the link still
    show which chat it is.
  - A turn steered by what it read can still propose a send to a chat Nocheh
    serves; it waits for the card wherever a card is needed today.
</consequences>
