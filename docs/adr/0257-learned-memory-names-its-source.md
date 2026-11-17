# ADR-0257: Learned memory names its source

<status>
Accepted on 2026-11-16, as the memory part of the fourth set of fixes from the
review of how text from outside reaches Nocheh (risk 5, "Other people's text
becomes your private memory", fixes 5a, 5b, 5c and 5g). The owner approved it on
2026-11-14 ("all yes") with its wording: keep learning everything, but record
where each piece came from; each note names its source, built by code and not by
the model, so a planted note can't borrow the owner's label; people not allowed
stay out of the owner's private notes but still count for group replies; what
others wrote is information, never the owner's own words or instructions. A
review of the design tightened it: "you" only for a review of nothing but the
owner's own messages that cites them, a note's earlier sources carried through
the operations that replace it, and a reported claim never made direct.
Reviews of the build closed gaps in pins and quotes (of Nocheh's own messages
too), messages a message embeds, checklists, polls, rules, recall, what a turn read,
failure counting and the full tester's checks; this record describes the result. Four
questions went to the owner; this builds the recommended answer to each, except
that a reply's or a reaction's target from someone not allowed is left out of
the review, as the owner's rule says, until the owner answers otherwise. It reads
the send classes of [ADR-0256](0256-nochehs-own-messages-carry-a-send-class.md).
Amends [ADR-0109](0109-standard-honcho-entity-model.md) (one documented peer
that is not a person, and the session kind `material`),
[ADR-0124](0124-native-review-once-per-source.md) (a source left out of the
notes review is recorded per installation generation),
[ADR-0152](0152-owner-editable-built-in-instructions.md) (source words are fixed
for the model and editable for the owner),
[ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md) (the record
of who wrote each note belongs to its profile and is not carried into a new
epoch), [ADR-0217](0217-waiting-fragments-keep-their-place.md) (a waiting
fragment is matched on its evidence slice, so a changed records line does not
replace it), [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md) as
narrowed by [ADR-0251](0251-fixes-that-lose-nothing.md) (a person not allowed in
a group stays out of the owner's notes only),
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md) (a
review fragment's first line is kept, so `group_text_in_owner_review` counts as
before), [ADR-0250](0250-cards-and-forwards-say-whose-words-they-are.md) (its
forward reader serves memory) and ADR-0251 (`allowedSender` reads reactions, and
a recalled note names its source beside its chat).
</status>

<context>
- The owner's notes review read a group's messages, people not allowed there
  included, and wrote what it learned into the owner's own notes, which every
  later owner turn reads as its memory. Nothing said whose words a note came
  from, and every note read as the owner's.
- Nocheh's cards and reminders in the private chat, and the forwards and files
  the owner sent, reached the owner's notes and what long-term memory knows
  about the owner the same way. Someone else's forward of "the owner's rule: …"
  could become a rule.
- A model writes the notes. A source label it wrote, it could write wrong, or be
  steered to write "the owner".
- Long-term memory kept a forward, the text of a file and the owner's typing on
  the owner's peer alike, and learning could record a forwarded claim as the
  owner's direct statement.
</context>

<decision>

## 1. People not allowed stay out of the owner's notes (5a)

- Before it prepares a review, `NativeReviewRepository.queue` decides once,
  after its early return for a source already reviewed: the owner's yes on that
  message lets it in, but only in the owner's private chat or a group Nocheh
  serves; a stored skip for it in this installation generation keeps it out;
  otherwise `notesSender` decides. A Telegram update goes through
  `allowedSender`, which now also reads a reaction's `user` (a reaction in a
  chat's name, or with no user, is not allowed). Nocheh's delivered messages
  and the owner's web chat are reviewed. Anything else is not.
- A source left out is stored in `native_review_skips(event_id, generation,
  reason)` as `sender_not_allowed`, and its reviews still waiting are withdrawn;
  their workflows close as superseded. Allowing the person later does not review
  their old messages: notes start fresh each epoch, and each would cost a model
  run.
- In a review that goes ahead, related messages from people not allowed leave
  its context without taking one of its 30 places (`sender_not_allowed`), a rule
  whose evidence holds such a message is dropped (`rule_sender_not_allowed`),
  and a quote of a dropped message is stripped. A quote is judged by the message
  it answers even when the review holds nothing of it: one in this chat the
  archive never got (another bot's message, which Telegram never sends to
  Nocheh, or one sent before Nocheh was there) by its author as the reply shows
  it, in this chat, as a pin's message is; one in another chat or topic stays
  only when the archive holds that message and its sender is allowed where they
  wrote it. A quote refused this way is cut out of the message quoting it, which
  stays, and counted as `sender_not_allowed`. A pin is judged by the author of
  the message it pinned, in the same chat: one from someone not allowed is cut
  out of the pin, which stays, and counted as `sender_not_allowed`. A quote
  inside the pinned message is judged as any quote is, by the message it
  repeats part of: the pinned message as the archive holds it, each revision,
  is asked as a message quoting is (`admitPinnedQuote`), so the quote stays only
  when the message it answers is archived and admitted or, never archived, its
  author as that reply shows it is allowed there. Telegram sends a pinned
  message without its reply, so the quote inside one the archive never got has
  nothing to judge it by and is cut too. A quote refused this way is cut out of
  the pinned message, which stays, and counted as `sender_not_allowed`, once per
  message. A pinned message Telegram no longer shows carries no words and is let
  through. Nocheh's
  own message, found in the archive as the same chat's message the pin names
  (the way a reply's target is found), is never someone not allowed: a learned
  one stays, and a card, notice or reminder is cut out without being counted,
  since it is not learned. A pin of a card with nothing else to review is not
  reviewed at all: nothing is recorded as kept out, its waiting reviews are
  withdrawn and its source step completes with `nocheh_message`; nor is it
  interpreted, and its long-term memory step, which still writes the pointer,
  completes with `nocheh_message` too. The same holds for a pin of Nocheh's own
  account's message the archive does not hold as Nocheh's (see below). Another
  bot's message is someone else's, and as a sender not allowed there it is cut
  out of a pin or quote of it and counted, in the notes review only. A reaction
  left with no target once one was dropped is skipped as `target_not_allowed`,
  so no run is spent on a bare emoji.
- Only the notes review applies these filters. Group replies, Honcho,
  interpretations, search and recall still take what a person not allowed sent,
  so that person still counts for group replies and group memory. What is
  learned (the notes review, Honcho and interpretations) cuts only Nocheh's own
  words, whoever sent the message carrying them: a pin loses Nocheh's card,
  notice or reminder, and Nocheh's own account's message the archive does not
  hold as Nocheh's learned one (its delivery not archived yet or failed to be,
  or a forward of Nocheh's message, which cannot tell a card from a learned
  reply); a quote of Nocheh's own words, of a forward of them and of a reply in
  another chat included, is left out of the message quoting it, and so is a
  quote inside the message a pin carries (`NoteSourceRepository.carried`).
  Nocheh's own account is told by equality alone: the carried message's
  `from.id`, or its forward origin's `sender_user.id`, against the bot account
  the archive stored with the update (`events.bot_id`, the bot token's own
  account), in `isBotAccount` in `src/chats-telegram.ts`, so nothing else reads
  an id's shape. When that stored bot is not an account, as for an import,
  these fields tell nothing and the labels stay as they are, someone else's.
  Everything else is still learned, labelled as someone else's: another bot's
  message (a pin of it by the owner is kept with the owner's forwards and
  files, a quote of it is someone else's quote), and a message sent through an
  inline bot (`via_bot`), which its sender wrote, labelled as sent through an
  inline bot. Group replies, search and recall learn nothing and are unchanged,
  and a card the owner replies to stays whole as related context of the reply
  in the notes review and interpretations (ADR-0256): only Honcho never writes
  it. A reply that quotes nothing carries none of its target's words into what
  is learned, and neither does a reply inside any message a message carries.
- A message a message embeds is kept and labelled, not cut (the owner prefers a
  guard to a removal): the checklist a service message reports on
  (`checklist_tasks_done`, `checklist_tasks_added`), a giveaway's message
  (`giveaway_completed`), a suggested post's (`suggested_post_approved` and the
  rest) and the poll an option was added to or deleted from
  (`poll_option_added`, `poll_option_deleted`). Code finds such a message by its
  shape alone, an object with a `message_id` and a `chat` and no `type` (every
  forward origin has one), at any depth and whatever field holds it, never by a
  field's name or an id, so one in a field Telegram adds later is found too
  (`embeddedMessages`). One that is not its sender's own typed message makes
  the message holding it someone else's words (section 2), whoever sent it.
  Only Nocheh's own words in it are cut, from everything learned, as from a pin:
  a message of Nocheh's own account, told by equality with `events.bot_id`, and
  a quote of one as its reply shows it (`nochehHeld`). Telegram leaves the reply
  out of an embedded message but keeps its quote, so a quote inside one with no
  reply to tell it by (`quotesToTrace`) is traced as a pinned message's quote
  is, through that message's own archived event: the same chat's message by the
  id Telegram gives it, looked up only when Telegram names the same chat for
  both, told by equality (`embeddedSource`, `NoteSourceRepository.embeddedTo`).
  It is cut from everything learned when a revision of that message answers
  Nocheh's words, and also when the archive does not hold that message, holds a
  revision of it answering nothing, or holds only Telegram Desktop exports of
  it, since then nothing tells whose words the quote repeats (it fails closed).
  An export records its reply as `reply_to_message_id`, which can't tell
  Nocheh's card from a learned reply, so it never traces a quote alone; beside a
  live revision that shows the reply, it answers as that one does. That second
  cut is counted as `quote_not_traced`, in the review's `left_out` and its
  records line (`quotes_not_traced`), and named among the learning context's
  limitations. Interpretations and Honcho read the rest, labelled. The owner's
  notes review judges each one by its author as it judges a message in that
  chat (`notesSender`), and a post in a chat's name is never allowed: one from
  someone not allowed there is cut out of the message holding it, the rest of
  that message stays, and the message counts once as `sender_not_allowed`. Every
  quote inside one is judged there as a pinned message's quote is, through that
  message's archived revisions in the same chat (`embeddedTo` with every quote),
  each asked as a message quoting is (`quotedSender`): one whose embedded copy
  keeps its reply to a message in another chat (`external_reply`) is judged by
  that message alone, as a top-level quote of one is, and stays when the archive
  holds it and its sender is allowed where they wrote it. One refused is cut and
  counted the same way.
  A message Telegram no longer shows (an `InaccessibleMessage`: date 0 and
  nothing but its chat, id and date, `inaccessible`) carries nothing and stays;
  one with date 0 and anything else, a shape Telegram does not send, is judged
  by its author as any message is. A poll option someone added is judged the
  same way, by `added_by_user`; one added in a chat's name (`added_by_chat`) is
  never allowed, and the text of an option deleted from a poll, which names no
  one, is cut there, except in the owner's own private chat, where the text of
  an option deleted from the owner's own poll that is not a forward is the
  owner's own (`ownDeletedOption`), since no one else can add one there. The
  review's store (`heldSenders`) returns the places it lets in, and the
  learning context cuts every other place it finds (`heldBy`, `cutHeld`), so a
  place the two read differently fails closed. A quote is judged by what the
  message it is from holds too, as the reply shows it now and as the archive
  holds it: a poll gets options added later without an edit of its message.
- Memory › Assistant notes says how many messages were kept out this generation
  (`kept_out` on the reviews list). Long-term memory and learning still take
  such a message, so in System › Background work its Memory notes step shows as
  Done, with the reason under it, and its details show that reason under
  "Note", as for every task that ended, not under "Waiting for": "From someone
  not allowed there: kept out of your notes, still in group memory", or for a
  reaction "A reaction to someone not allowed there: kept out of your notes,
  still in group memory". `queue` returns that reason only when it decided it
  in the same call, so a source reviewed earlier never shows it.

## 2. Each message gets a class from code facts

- `src/source-facts.ts` reads each channel's own fields, never message text: the
  author (owner, person, anonymous, bot, Nocheh or unknown), the act, a forward
  and its origin's kind, a quote and whose it is, file text, an audio
  transcript, a recording, the send class and `answers`. An unknown channel is
  never the owner. `ownerTyped` holds only for the owner's own message, edit,
  reaction or web-chat message with no forward of someone else, no inline bot,
  no post in a chat's name, no quote of someone else, no pin of someone else's
  message, no words in it that may be someone else's (a checklist, a poll or a
  message it embeds, below) and no file or audio text. A pin has no words of
  its own and carries
  those of the message it pinned: a pinned forward is a forward, someone else's
  message is `pinned`, and only the sender's own message stays theirs. A quote
  is the sender's own only when the message it answers is theirs and is not a
  forward of someone else's (`forwardFacts`, an inline bot's message included),
  as a pin's message is read: the owner's quote of their own forward quotes
  whoever wrote it, so it is never the owner's typing, class or bucket. A quote
  of a message in another chat or topic (`external_reply`) is judged by that
  message alone and is never the sender's own: Telegram names only who first
  sent it, not whether it was a forward or sent through an inline bot, and in a
  forum topic it also points `reply_to_message` at the topic's first message,
  which the quote is not from. A Telegram Desktop export's message is a forward
  when it carries any of the export's forward fields, whatever they hold:
  `forwarded_from` (a deleted account's is `null`), `forwarded_from_id` or
  `saved_from`. A checklist names no one per task, and its
  `others_can_add_tasks` says only what others may do now, since its sender can
  turn it off once others have added tasks. So a checklist others can add tasks
  to, and any checklist shown again (an edit of it, the message a pin carries,
  the message a quote is from, and the sender's forward of their own), is read
  as one with someone else's words in it, whoever sent it (`sharedChecklist`):
  `pinned`, or `quote` for a quote of one, both in the person group, the
  classes a pin or quote of someone else's message already has. Only a new
  checklist that only its sender can add to stays the sender's own, and in the
  owner's private chat with Nocheh, where no one else can add tasks
  (`ownerChat`, told by equality), the owner's checklist that is not a forward
  stays the owner's own, new, edited, pinned or quoted; in a group it fails
  closed. A poll is read the same way when an option in it was added by
  someone else, in a chat's name (`added_by_chat`) or by another account
  (`added_by_user`, told by equality) (`pollByOthers`), and so is the service
  message for an option deleted from a poll (`poll_option_deleted`), whose
  adder Telegram does not name, except the owner's own poll that is not a
  forward in the owner's private chat (`deletedOwn`), and a message that embeds
  one that is not its sender's own typed message, or one that quotes a message:
  Telegram keeps the quote of an embedded message but not the reply, so such a
  quote is never told as the sender's own (`othersIn`, read for the embedded
  message as for the one a pin carries). The `held` fact marks a message that
  itself holds such words, as against a pin of them, so its labels claim no
  pin; `pinned_held` marks a pin of the sender's own such message, so its labels
  say the sender pinned a message holding others' words, never that someone
  else wrote it. A Telegram
  Desktop export names no one per task or option, so its checklist
  (`todo_list`) or poll is read the same way, whoever the archive proved sent
  it. The text of all of these is still learned.
- `eventClass` gives one fixed token per message, such as `owner_message`,
  `person_message`, `forward_hidden_by_owner`, `file_by_person`, `pinned`,
  `nocheh_job_report`, `nocheh_about_forward` or `unknown`, in five groups:
  owner, Nocheh, person, forward and file. The owner's quote of Nocheh's own
  learned message, found through the archive's reply relation, is
  `quote_nocheh` and counts with Nocheh's messages. The owner's pin of one,
  found as the same chat's message the pin names, is `pinned_nocheh`. A quote or
  pin of Nocheh's card, notice or reminder, of its reply about a forward, or of
  a message not found stays a quote or pin of someone else's (it fails closed),
  whatever is cut from what is learned.
- A review stores its `provenance` with its job: each message's class, whether
  every message was the owner's own typing, whose rules it read, whose words
  those rules rest on (`rule_buckets`: `person`, `forward`, `file`) and what was
  left out. A rule is judged by the inputs code recorded when it was learned
  (its stored dependencies), never by what the model cited. It is the owner's
  only when the owner wrote it: a rule learned automatically, even from nothing
  but the owner's own messages, can restate a rule or Honcho's chat that its
  interpretation read, since its recorded inputs name neither. A file's text or
  a transcript is judged through the message it belongs to; any other input is
  someone else's, and Nocheh's own messages are not the owner's. In a review of
  nothing but the owner's own messages, every rule the owner did not write is
  left out of that review only (`rules_left_out_for_owner_label`). In a review
  of Nocheh's own learned messages, alone or with the owner's own messages (its
  cards and notices are not learned, and the owner's quote or pin of a learned
  one counts with them), the rules resting on another person's message, a
  forward, a file or an input that can't be told are left out the same way and
  counted there, so its notes read `nocheh` rather than as others'; a rule
  learned from the owner's own messages stays there, since such a review's notes
  are never the owner's. `owner_account_only` stays false for such a review. A
  provenance stored before `rule_buckets` existed reads its rules from others as
  another person's.
- The review fragment's first line stays byte for byte. A second line, Nocheh's
  records, is one JSON object in fixed words with no names, listing each
  message's full id under its class's phrase, at most 3,700 characters. A fixed
  third line opens the evidence. The evidence slice is a fixed 7,500 characters,
  so a fragment stays within 11,900 and a changed records line never moves a
  cut.

## 3. Each note carries a label built by code (5b)

- **Who wrote it.** Hermes's parent process reads a profile's notes before and
  after every run that can write them, under the notes lock (waiting at most 30
  seconds), and records the origin of each entry the run added or changed in
  `nocheh-note-sources.json`. The file is in the profile root, outside the
  folders an isolated run can write. An origin is a notes review by its id, or a
  turn by the message it answered, its channel, its day and what it read up to
  its last memory call: a forwarded message, a file, recent group messages,
  other chats (a search by meaning included, since its hits carry no source),
  web pages, Notion, tool servers, command results, past conversations or other
  tools. Earlier in its session since the last compaction, the forwards, files
  and recent group messages it was given count too, and so does a tool result
  or another person's group message when what the turn wrote shares a run of 32
  characters or a distinctive token with it; an earlier read it did not copy
  from leaves the note the turn's own, so a note the owner dictates later in a
  long session is not marked as read. A forward of the sender's own earlier
  message is their words, not a read, in the message a turn answers. Earlier in
  the session only the owner's own forward in their private chat is skipped,
  the line `[Forwarded: your own earlier message]`. Anywhere else an own forward
  is written `[Forwarded: the sender's own earlier message]`, whoever sent it (a
  member in a group, or the owner in a group or in a private answer carried
  from one), and counts as a forward read, copied or not; for the owner's own
  that fails closed, so the note is `turn_read`, not `turn`. A note
  keeps the origins of the notes it replaced through the replace and patch
  operations the run asked for (every removed note, when those are not known),
  and of any earlier note, not the owner's own, it shares a run of 32
  characters, a distinctive token or its whole text (ignoring case and spacing)
  with. A note keeps at most 10 origins and counts the rest, and one that had to
  drop origins also reads as partly unknown. A note with no record reads
  "source not recorded".
- **The label is made when the note is read.** `/internal/notes/sources`
  (service token only) turns a note's origins and citations into `{from,
  label}`. `from` is one fixed token: `owner`, `nocheh`, `person`, `forward`,
  `file`, `mixed`, `turn`, `turn_read`, `unknown` or `unavailable`. `owner`
  needs all of these: a review with provenance of nothing but the owner's own
  typing, whose source is among its messages, with nothing left out and no rules
  but those the owner wrote; and a note that cites at least one message, every
  one of them in that review, and no more than 20 of them. Citations only ever
  narrow trust. An all-owner review whose note cites none reads `nocheh`. Rules
  a review read that rest on another person's message, a forward or a file make
  the note `person`, `forward`, `file` or `mixed`, and its label says it read
  rules learned from others; only a review that holds someone else's words reads
  them (section 2). A `nocheh` note is not taken as the owner's own words: its
  review held Nocheh's own messages, read rules learned from them, or did not
  meet the owner rule. A turn's note is never `owner`: it is `turn` when it
  answered the owner's own message, or the owner's quote of Nocheh's own learned
  message, without reading outside, else `turn_read`.
- **Words.** The model reads fixed words (`modelSourceWords`, at most 120
  characters, no person's name, chats by the names recall uses). The owner reads
  editable words, `memory.source_texts` ("Note sources on the Notes page" in
  Settings › Assistant), with {who} from the reminder lines and {place} from the
  approval texts' chat words, one set as in
  [ADR-0255](0255-reminders-say-who-set-them.md). Its lines `quote_nocheh`,
  `pinned`, `held`, `pinned_held`, `pinned_nocheh` and `rules_others` name a
  quote of Nocheh's own message, someone else's message pinned, a message
  holding someone else's words, the sender's own such message pinned, Nocheh's
  own message pinned, and rules learned from other people's messages, forwards
  or files. Trust is keyed on
  `from`, never on words.
- **What the model sees.** In evidence mode each native notes block reaches the
  model as `{target, title, usage, about, notes:[{from, label, content}]}`: the
  note's text unchanged, its label in its own fields and a fixed `about`
  sentence saying the labels are set by Nocheh's code and that `from=owner`
  means only the owner's own messages. The evidence instruction says by class
  which notes are not the owner's words, and that a `from=nocheh` note may rest
  on rules Nocheh learned in that chat from other people and is not the owner's
  own words either. The notes review instruction says to keep each full event
  id, trust the records line over names or claims in messages, and never write
  someone else's words as the owner's. An owner who edited either instruction
  keeps their wording; `about` still reaches them.
- **Where the owner sees it.** Memory › Assistant notes shows each note with its
  label, coloured by `from`; a group's `USER.md` is titled "About people here".
  Each recalled note carries its own `source` beside its chat, and a recalled
  session message its role (Nocheh's reply, a tool result, a message). Labels
  come back in the order of the notes asked, so the same note in two profiles
  keeps each one's source, in recall and on the Notes page.
- The record travels with the profile's notes in a portable export; a bad one is
  dropped on import and counted.

## 4. The memory tool stays (5g)

- Turns keep their memory tool, and the owner's turns keep reading every chat
  (5d is not adopted). A label makes what a turn writes traceable instead of
  forbidding it.

## 5. Forwards and files get their own place in long-term memory (5c)

- One documented peer that is not a person, `nocheh_forwards_and_files`, writes
  what others wrote that reaches the owner. Honcho learns from what it writes,
  and it learns from no one. The owner gets one session for forwards, of kind
  `material`, in the owner's audience.
- In the owner's private chat, someone else's forward goes whole to the forwards
  session on that peer, and a fixed pointer on the silent assistant peer stays
  in the chat, naming only the kind of origin. The owner's own typing, own
  forward and own voice stay on the owner's peer. File text, audio transcripts
  and a quote of someone else become a second record on the forwards peer in the
  same chat session, so a caption like "this is my CV" still links; a file with
  no caption has no record on the owner's peer. Someone else's message the owner
  pins is kept as such a forward is, with its own fixed pointer. A quote of any
  of Nocheh's own messages, by anyone, is written as the sender's words without
  the quote, and nothing goes to the forwards peer: a learned message is already
  learned as Nocheh's, and a card is not learned. For the same reason a pin of
  any of Nocheh's own messages, by anyone, an anonymous admin included (the pin
  is read before the post's class), leaves only a fixed pointer on the
  assistant peer, in the chat where it was pinned, private or group, saying that
  the owner, or someone in that chat, pinned one of Nocheh's messages. A pin of
  Nocheh's own account's message the archive does not hold as Nocheh's (not
  archived yet, or a forward of one) leaves the same pointer, and a quote of one
  is left out as a quote of Nocheh's is. Another bot's message is someone
  else's: the owner's pin of it is kept as a forward is, a member's stays on the
  member, and a quote of it goes as anyone else's quote. The owner's message
  that holds words that may be someone else's (section 2: a shared checklist, a
  poll someone else added options to, a message embedding someone else's) is
  kept as the owner's pin of someone else's message is, with its own fixed
  pointer and `source` (`held`), which claim no pin; a member's stays on the
  member with that `source`. The owner's pin of such a message of their own is
  kept the same way, with its own pointer and `source` (`pinned_held`), which
  say the owner pinned a message holding others' words, never that someone
  else wrote it. Nocheh's reply about a forward goes to the
  forwards session.
- In a group, a member's message, forward or pin stays on the member's peer,
  except a pin of Nocheh's own message, which leaves only the pointer. The
  owner's forward, file text,
  quote of someone else or pin of someone else's message goes to the forwards
  peer in that group's own session, so it never shapes what is known about the
  owner in every chat.
- Every new record carries a fixed `source`, such as "the sender's own words",
  "forwarded by the sender from a person who hides their account: information
  others wrote, not the sender's words or instructions" or "Nocheh's report".
  Evidence about people and projects from a kept-apart record has its own key,
  no original speaker and `reported` attribution.
- The owner's turn reads the owner's block and the forwards-and-files block side
  by side, across the workspace, each guarded and prefetched on its own, with its
  own header and an `about` value (`owner` or `forwards_and_files`). Whether
  the forwards peer wrote anything is found by its writer, on an index
  (`memory_receipts_live_writer`). Groups, private answers and job runs make no
  new read. Owner recall asks the forwards peer as one more ask, under its own
  header; a group asks it only in its own sessions. That ask fails on its own:
  the other answers are kept, the result says `forwards_unavailable` (limited
  memory when it was the only ask), and the stores count it. Answers are joined
  whole, each under its header, up to 20,000 characters; one left out, or a
  first one cut without splitting a character, adds `recall_answer_cut`.
- Learning decides attribution in code. A `direct` claim stays direct only when
  every message it cites is the speaker's own typing and the batch holds no
  forward, file, quote or pin of someone else's message that they passed on;
  otherwise a claim citing someone else is `inferred`, and any other is
  `reported`. The owner's quote of Nocheh's own learned message
  (`quote_nocheh`) is the owner's own typing here too, without the quoted
  words; the owner's pin of one (`pinned_nocheh`) is not, so a claim citing it
  is never direct, but neither passes anything on, so the owner's other claims
  beside them can stay direct. Nor does a pin or quote whose words were cut from
  what is learned: of Nocheh's card, notice or reminder, or of Nocheh's own
  account's message the archive does not hold as Nocheh's; a claim citing one is
  never direct. Another bot's message is someone else's, passed on.
- A source already written in the earlier form is planned in that form again
  (the `record_kind` format guard), so its ids match and nothing goes stale.
  This change starts no Honcho rebuild, re-learn or new workspace of its own:
  only newly learned messages take the new routing, and a message already
  written is not written again unless something requeues it (an edit, a
  correction or a rebuild). Then one whose text is now cut or kept differently
  (a pinned card or Nocheh's message not archived yet, a quote of Nocheh's
  words, another bot's pinned or quoted message) is written anew and its
  session rebuilt, as for any source whose text changed. Writes a rebuild
  retired count too, so a message requeued after a rebuild keeps its earlier
  form; a fresh start's new workspace has none and uses today's form. An index
  on the source (`memory_receipts_source`) keeps the check quick.
- Honcho v3.6.0 makes no embeddings call for these reads: it embeds only for a
  `search_query`, which Nocheh never sends.

## 6. Failures reach the owner

- A label lookup, a record, a notes read, a lock wait given up, a record file
  that can't be read, a restore, a turn that wrote a note but whose stored
  messages could not be read, and a turn whose memory came without the
  forwards block (`forwards_unavailable`) or without its context are each
  counted per day in Hermes's usage database, once per failed attempt, not per
  note, so a failure that comes back grows the count. The stores count the
  same way, in `memory_problem_days`: a label lookup for recall or the Notes
  page that fails, a lookup that can't name a review's chat (the labels still
  go out), Hermes's lookups before a turn or review included, and recall's ask
  of the forwards and files. A step that works is written only once
  that day's count holds a failure of its kind, which is all the notice needs to
  say it works again, so steady use writes nothing. `/v1/status` reports today's
  counts as `memory_problems`. The problem notice says "Memory labels: telling
  where notes came from failed {count} times today. Notes written while it
  failed show “Source not recorded” or a less exact source, and replies may have
  seen “source not available”. The notes themselves are kept." and "Long-term
  memory: Nocheh couldn't read memory from your forwards and files, or your
  memory context, {count} times today; replies used the rest of your memory."
  The stores' counts are lines of their own (`note_labels`, `forwards_read`), so
  a step that works on one side never clears a failure on the other: "Memory
  labels: looking up where notes came from failed {count} times today. Recall
  and the Notes page showed those notes as “source not available right now” or
  without their chat, and replies may have seen them without their chat. The
  notes and what was recorded about them are kept." and
  "Long-term memory: recall couldn’t ask your forwards and files {count} times
  today; it answered from the rest of your memory." They clear only when the
  stores' counts were read. System › Health says the same. A failure never
  stops a turn.

</decision>

<alternatives>
- **5d, the owner's memory limited to the private chat.** Not adopted: it would
  lose recall across chats that the owner uses.
- **5f, a cut on long recordings from people not allowed.** Already built in
  ADR-0251.
- **A label written by the model, or read from a note's text.** Rejected: a
  planted note could claim the owner's label.
- **Inheriting from every note a run removed.** Kept only for a run whose
  operations are not known; otherwise unrelated notes would lose their trust.
- **One peer per forward's sender.** Not built: Telegram rarely proves who wrote
  a forward. Left for when it does.
- **Moving the owner's own file text out of the chat session.** Rejected: a
  caption would no longer link to its file.
- **Learning old data again in the new form.** Needs the owner's yes; replacing
  long-term memory from saved messages does it.
- **Labels on search hits.** A follow-up: search hits are archive messages, not
  notes, and nothing there got worse.
</alternatives>

<consequences>
- What the owner loses, all for newly learned messages only:
  - A group message from a person not allowed there leaves the owner's notes
    only. Group replies, the group's long-term memory, interpretations, search
    and recall from the private chat, labelled with the group, keep it.
  - The owner's own posts as an anonymous group admin, and a linked channel's
    automatic forwards, leave the owner's notes, as ADR-0251 already counts them
    as not allowed. Long-term memory keeps them, and the owner's yes on one still
    adds it.
  - The owner's reply to a person not allowed there is reviewed without that
    person's message, and a reaction to one is not reviewed (an open question
    for the owner). A pin of such a message is reviewed without the message it
    pinned.
  - In a review of only the owner's own messages, or of those and Nocheh's own
    learned messages, conventions learned from others, or from a thread that
    held others' messages, are left out of that review; a review of only the
    owner's own messages also leaves out every rule learned automatically, even
    from the owner's own messages, and reads only the rules the owner wrote.
    Turns and every other review still read them.
  - In the owner's notes review, a quote of another bot's message, of a message
    the archive never got from someone not allowed there, or of a message in
    another chat or topic that the archive does not hold or whose sender is not
    allowed there, is cut out of the message quoting it. So is a quote inside a
    pinned message, judged by the message it quotes as the archive holds the
    pinned message; Telegram sends a pinned message without its reply, so the
    quote inside one the archive never got can't be traced and is cut too. The
    message stays, and interpretations and long-term memory keep the quote,
    labelled as someone else's.
  - A quote inside a message another message embeds (a poll an option was
    added to or deleted from, the checklist a "tasks done" message reports on),
    which Telegram shows without its reply, is no longer the owner's own words:
    the message holding it is labelled as holding someone else's words. It is
    traced through the embedded message as the archive holds it. One quoting
    Nocheh's words is cut from everything learned, as a quote of Nocheh's is.
    One the archive can't trace, because Nocheh never got that message (sent
    before Nocheh was there, or unseen in privacy mode) or holds it answering
    nothing, is cut from everything learned too, even when it quoted the
    owner's or an allowed person's words, and counted as a quote that could not
    be traced; the rest of the message stays. One traced to someone else's
    message stays for interpretations and long-term memory, and in the owner's
    notes review only when whoever wrote the message it quotes is allowed there.
  - The owner's quote of their own message in another chat or topic, and a
    Telegram Desktop export's forward with no name for its sender (a deleted
    account's, or one marked only by `forwarded_from_id` or `saved_from`), are
    no longer the owner's own typing: they are labelled a quote of someone
    else's message and a forward from someone Nocheh cannot identify, and their
    text is still learned.
  - A pinned message's own reply to a message in another chat (a poll, a contact
    or a venue it answers) is no longer learned with the pin; the pin's message
    is learned without it, as every message is learned without the message it
    answers.
  - A service message that carries someone else's message (the checklist a
    "tasks done" or "tasks added" message reports on, a giveaway's or a
    suggested post's message, the poll an option was added to) is no longer the
    owner's own typing when the owner sent it: it is labelled as a message
    holding someone else's words, on the Notes page "a message you sent ...
    holding someone else's words, such as a shared checklist or poll", kept
    with the owner's forwards and files in long-term memory, and all its text is
    still learned. In the owner's notes review the carried message, or a poll
    option, from someone not allowed there is cut out of it, and so is the text
    of an option deleted from a poll, the message counted as kept out;
    interpretations and long-term memory keep them. In the owner's private
    chat the owner's deletion of an option from their own poll stays the
    owner's own words, its text kept. The owner's pin of their own poll someone
    else added an option to, or of their own message holding someone else's
    words, reads on the Notes page "a message holding someone else's words,
    such as a shared checklist or poll, that you pinned", never as someone
    else's message.
  - The owner's checklist others can add tasks to, every edit, pin or quote of
    the owner's own checklist, and the owner's forward of it, are no longer the
    owner's own typing in a group: Telegram names no one per task and the owner
    can stop sharing a checklist after others added tasks. So is the owner's
    poll that someone else added an option to. They are labelled as a message
    holding someone else's words, or a pin or quote of someone else's message,
    kept with the owner's forwards and files in long-term memory, and their
    text is still learned. A new checklist only the owner can add to, and in the
    owner's private chat with Nocheh any of the owner's checklists that is not
    a forward, stay the owner's own.
  - A Telegram Desktop export's checklist or poll is never the owner's own
    typing, since the export names no one per task or option; it is labelled as
    a message holding someone else's words and still learned.
  - Allowing someone later does not add their old messages to the notes.
  - Others' forwards, and others' messages the owner pins, leave the private
    chat's long-term memory session. A follow-up like "book the 7am one" is
    learned beside the pointer only, while the forwards block, read on every
    owner turn, and the archive keep the content. Nocheh's replies about
    forwards move to that block.
  - The owner's own file and audio text no longer shapes what is known about the
    owner directly. It is read on every owner turn as its own block and found by
    recall, and its caption still links in the same session.
  - Claims resting on forwards, files or others' messages are reported or
    inferred, never direct. They are still kept.
  - Many notes read "Nocheh" or mixed rather than "you" when Nocheh's reply or
    others' messages were in the review. A review that holds others' messages
    reads every rule of its chat, so a rule learned from a forward or a file can
    make its note mixed; a review of only the owner's and Nocheh's own messages
    leaves such rules out and stays `nocheh`. That is correct; person, forward,
    file, mixed and turn_read notes are marked as others' words, and a `nocheh`
    note is not the owner's own words either.
  - Small costs: one more parallel long-term memory read per owner turn
    (prefetched, with one guard check when it changes); one more recall ask; two
    records for an own message with a file; about 3,700 more characters per
    review fragment, with the evidence slice 7,500 characters instead of 8,000;
    about 2,000 to 4,000 characters of labels per model call (cached); one
    label lookup per turn; two more indexes on long-term memory receipts; and a
    small daily count table.
- At deploy, waiting reviews get the new fragment form and keep their attempts.
  A long source whose review had already run in part loses its other waiting
  fragments, whose old text never matches a new slice, as ADR-0217 does for a
  fragment whose text changed. A review already waiting under the current epoch
  runs once with the related messages it was prepared with; only one whose own
  sender is not allowed is withdrawn.
- Notes written before this change read "source not recorded" until the next
  epoch starts fresh notes. Long-term memory keeps its earlier form: re-learning
  chats keeps each message's earlier form, and replacing long-term memory from
  saved messages learns them by today's rules, as Memory › Long-term › Re-run
  says.
- Full tester: `not_allowed_group_text_stays_out_of_owner_notes`,
  `display_name_cannot_borrow`, `forward_kept_apart_and_labelled` and
  `own_file_stays_recallable`, with new checks in the forwarded message,
  reminder, card, job report, notes, document, photo and voice scenarios. The
  tester's Honcho answers a memory chat with the fixture's deterministic model,
  which never searches, so `own_file_stays_recallable` checks that recall asked
  the forwards-and-files participant, got its answer (no
  `forwards_unavailable`), and that this participant holds the file's text in
  Honcho, not that the answer quotes it. The owner's notes reviews run one at a
  time and hold the background slot the steps that queue or skip them share, so
  every check that can wait behind them (a review, a message's notes and memory
  steps settling, an import's review steps) waits up to 40 minutes. It stops at
  once when the review it waits for is paused, or still uncertain once Nocheh
  gave up observing it (`nativeReconcileLimit` looks, read from the code; its
  workflow then closes as `native_review_unconfirmed`), since one failed look
  while Hermes restarts leaves later looks to find it done. Its timeout names
  how many reviews were still waiting, or says that count is unknown. The
  tester's Honcho takes the real setup's query and input limits (ADR-0228), so a
  learning query as long as Nocheh sends is taken there too, and asks for
  `json_object` answers at every dialectic level as the real setup does, from
  the same settings code.
- **Residuals:**
  - Labels and instructions are honoured by the model, not enforced. A labelled
    planted note can still steer a turn, so approval cards remain the real stop.
  - A review of only the owner's messages can restate an earlier note in fresh
    words. In-review citations and shared-token inheritance narrow this; a full
    paraphrase escapes.
  - The owner's own file text stays in the owner's long-term memory window by
    design. A planted file can still shape a conclusion about the owner, and the
    owner block's header says so.
  - A Nocheh group reply that restates a member is learned as Nocheh's.
  - Copies sent with the sender hidden, pasted text, and hidden-user forwards of
    the owner's own messages can't be told apart (ADR-0250).
  - Search hits carry no source.
  - The legacy memory-context mode and the non-isolated mode are unlabelled, and
    in non-isolated mode a run could reach the record file. Fresh installations
    use evidence mode, isolated.
  - A turn's reads are listed up to its last memory call, not per note. An
    earlier tool result or group message that a later turn restates in its own
    words, without a shared run or token, is not counted as read.
  - A rule's recorded inputs are not checked against who is allowed there; only
    the messages it cites are (`rule_sender_not_allowed`). Only a review that
    holds others' words reads such a rule, and its note reads as another
    person's, never the owner's or Nocheh's.
  - A rule learned automatically from the owner's messages can restate a rule,
    or Honcho's chat, that its interpretation read. It is never the owner's
    rule, so a review of only the owner's messages leaves it out, but a review
    of the owner's and Nocheh's own messages reads it, and its note reads
    `nocheh` rather than as another person's.
  - Members: `canLearn` reads the owner's yes on a message before it checks that
    the chat is served. The notes review checks both; Members step 4 must close
    it in `canLearn`.
  - No test covers Hermes counting `forwards_unavailable` yet.
  - A pin or quote handled before Nocheh's own message is archived, or after
    its capture failed, is labelled as a pin or quote of someone else's message
    (it fails closed). Its words come from Nocheh's own account, the bot the
    update came to, so they are cut from the notes review, interpretations and
    long-term memory, which keeps only a note that one of Nocheh's messages was
    pinned, and a pin of only that is neither reviewed nor interpreted;
    Nocheh's message is learned as its own source once archived. Where the
    stored bot is not an account (an import), nothing is cut by these fields,
    and the pin or quote is learned as someone else's.
  - A forward of Nocheh's message, sent on its own rather than pinned or
    quoted, is learned as a forward from a person shown as Nocheh: someone
    else's, never the owner's words, but its text is kept, card or not.
  - A checklist others can add tasks to names no one per task, so a task that
    someone not allowed there added reaches the owner's notes review when the
    checklist is shown again (an edit, a pin or a quote of it, or a service
    message carrying it that someone allowed sent), labelled as someone else's
    words, never the owner's; their own service message saying they added it
    (`checklist_tasks_added`) is kept out as theirs. A message Telegram no
    longer shows inside another (date 0 and nothing but its chat, id and date)
    carries nothing to judge and stays.
  - A quote inside an embedded message whose message the archive never got,
    holds in a revision answering nothing, or holds only as Telegram Desktop
    exports, is cut from everything learned, whoever it quoted, since nothing
    tells whose words it repeats; it is counted as `quote_not_traced`. A quote
    inside an embedded message that answers one in another chat
    (`external_reply`) is judged by that message alone, as a top-level quote of
    one is: in the owner's notes review it stays when the archive holds the
    embedded message and the one it answers and that one's sender is allowed
    where they wrote it, and is otherwise cut and counted as
    `sender_not_allowed`.
  - A poll option Telegram shows with no adder is read as the poll's own, its
    sender's, since Telegram names who added every option added after the poll
    was sent; Nocheh can't tell otherwise.
  - A quote of Nocheh's message is cut whole, so the notes review and
    interpretations no longer see which part of it was quoted.
  - Hermes's own `notes` line adds up its own steps, so a lookup that works can
    mark a record failure of the same day working again.
  - On deploy day, today's store failures, already shown in Hermes's lines,
    show once more as a `note_labels` line.
  - The owner's own forward in a group, or in a private answer carried from
    one, is written as the sender's own earlier message and counts as a forward
    read in later turns of that session, so their notes read `turn_read`
    (it fails closed).
</consequences>
