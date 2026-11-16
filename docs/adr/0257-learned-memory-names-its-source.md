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
the operations that replace it, and a reported claim never made direct. A
review of the build closed gaps in pins, rules, quotes of Nocheh, recall, what a
turn read and failure counting; this record describes the result. Four
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
  and a quote of a dropped message is stripped. A pin is judged by the author of
  the message it pinned, in the same chat: one from someone not allowed is cut
  out of the pin, which stays, and counted as `sender_not_allowed`. A pinned
  message Telegram no longer shows carries no words and is let through. A
  reaction left with no target once one was dropped is skipped as
  `target_not_allowed`, so no run is spent on a bare emoji.
- Only the notes review applies these filters. Group replies, Honcho,
  interpretations, search and recall prepare their context exactly as before, so
  a person not allowed still counts for group replies and group memory.
- Memory › Assistant notes says how many messages were kept out this generation
  (`kept_out` on the reviews list). Long-term memory and learning still take
  such a message, so in System › Background work its Memory notes step shows as
  Done, with the reason under it: "From someone not allowed there: kept out of
  your notes, still in group memory", or for a reaction "A reaction to someone
  not allowed there: kept out of your notes, still in group memory". `queue`
  returns that reason only when it decided it in the same call, so a source
  reviewed earlier never shows it.

## 2. Each message gets a class from code facts

- `src/source-facts.ts` reads each channel's own fields, never message text: the
  author (owner, person, anonymous, bot, Nocheh or unknown), the act, a forward
  and its origin's kind, a quote and whose it is, file text, an audio
  transcript, a recording, the send class and `answers`. An unknown channel is
  never the owner. `ownerTyped` holds only for the owner's own message, edit,
  reaction or web-chat message with no forward of someone else, no inline bot,
  no post in a chat's name, no quote of someone else, no pin of someone else's
  message and no file or audio text. A pin has no words of its own and carries
  those of the message it pinned: a pinned forward is a forward, someone else's
  message is `pinned`, and only the sender's own message stays theirs.
- `eventClass` gives one fixed token per message, such as `owner_message`,
  `person_message`, `forward_hidden_by_owner`, `file_by_person`, `pinned`,
  `nocheh_job_report`, `nocheh_about_forward` or `unknown`, in five groups:
  owner, Nocheh, person, forward and file. The owner's quote of Nocheh's own
  learned message, found through the archive's reply relation, is
  `quote_nocheh` and counts with Nocheh's messages. A quote of Nocheh's card,
  notice or reminder, of its reply about a forward, or of a message not found
  stays a quote of someone else's.
- A review stores its `provenance` with its job: each message's class, whether
  every message was the owner's own typing, whose rules it read, whose words
  those rules rest on (`rule_buckets`: `person`, `forward`, `file`) and what was
  left out. A rule is judged by the inputs code recorded when it was learned
  (its stored dependencies), never by what the model cited. It is the owner's
  when the owner wrote it, or when it was learned from at least one message and
  every one is the owner's own typing. A file's text or a transcript is judged
  through the message it belongs to; any other input is someone else's, and
  Nocheh's own messages are not the owner's. In a review of nothing but the
  owner's own messages, rules not drawn from them are left out of that review
  only (`rules_left_out_for_owner_label`). A provenance stored before
  `rule_buckets` existed reads its rules from others as another person's.
- The review fragment's first line stays byte for byte. A second line, Nocheh's
  records, is one JSON object in fixed words with no names, listing each
  message's full id under its class's phrase, at most 3,600 characters. A fixed
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
  message is their words, not a read, in the message a turn answers; earlier in
  the session only the owner's is, since in a group it is a member's words. A
  note keeps the origins of the notes it replaced through the replace and patch
  operations the run asked for (every
  removed note, when those are not known), and of any earlier note, not the
  owner's own, it shares a run of 32 characters, a distinctive token or its
  whole text (ignoring case and spacing) with. A note keeps at most 10 origins
  and counts the rest, and one that had to drop origins also reads as partly
  unknown. A note with no record reads "source not recorded".
- **The label is made when the note is read.** `/internal/notes/sources`
  (service token only) turns a note's origins and citations into `{from,
  label}`. `from` is one fixed token: `owner`, `nocheh`, `person`, `forward`,
  `file`, `mixed`, `turn`, `turn_read`, `unknown` or `unavailable`. `owner` needs
  all of these: a review with provenance of nothing but the owner's own typing,
  whose source is among its messages, with nothing left out and no rules but the
  owner's; and a note that cites at least one message, every one of them in that
  review, and no more than 20 of them. Citations only ever narrow trust. An
  all-owner review whose note cites none reads `nocheh`. Rules a review read
  that rest on another person's message, a forward or a file make the note
  `person`, `forward`, `file` or `mixed`, and its label says it read rules
  learned from others. A `nocheh` note is not taken as the owner's own words:
  its review held Nocheh's own messages, read rules learned from them, or did
  not meet the owner rule. A turn's note is never `owner`: it is `turn` when it
  answered the owner's own message, or the owner's quote of Nocheh's own learned
  message, without reading outside, else `turn_read`.
- **Words.** The model reads fixed words (`modelSourceWords`, at most 120
  characters, no person's name, chats by the names recall uses). The owner reads
  editable words, `memory.source_texts` ("Note sources on the Notes page" in
  Settings › Assistant), with {who} from the reminder lines and {place} from the
  approval texts' chat words, one set as in
  [ADR-0255](0255-reminders-say-who-set-them.md). Its lines `quote_nocheh`,
  `pinned` and `rules_others` name a quote of Nocheh's own message, someone
  else's message pinned, and rules learned from other people's messages,
  forwards or files. Trust is keyed on `from`, never on words.
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
  pins is kept as such a forward is, with its own fixed pointer. The owner's
  quote of Nocheh's own learned message is written as the owner's words without
  the quote, which is already learned as Nocheh's, and nothing goes to the
  forwards peer. Nocheh's reply about a forward goes to the forwards session.
- In a group, a member's message, forward or pin stays on the member's peer.
  The owner's forward, file text, quote of someone else or pin of someone
  else's message goes to the forwards peer in that group's own session, so it
  never shapes what is known about the owner in every chat.
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
  `reported`.
- A source already written in the earlier form is planned in that form again
  (the `record_kind` format guard), so its ids match and nothing goes stale.
  There is no Honcho rebuild, re-learn or new workspace: only newly learned
  messages take the new routing. Writes a rebuild retired count too, so a
  message requeued after a rebuild keeps its earlier form; a fresh start's new
  workspace has none and uses today's form. An index on the source
  (`memory_receipts_source`) keeps the check quick.
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
  page that fails or can't name a review's chat (the labels still go out), and
  recall's ask of the forwards and files. `/v1/status` reports today's counts
  as `memory_problems`, and the notice adds them in. The problem notice says
  "Memory labels: telling where notes came from failed {count} times today.
  Notes written while it failed show “Source not recorded” or a less exact
  source, and replies may have seen “source not available”. The notes
  themselves are kept." and "Long-term memory: Nocheh couldn't read memory from
  your forwards and files, or your memory context, {count} times today; replies
  used the rest of your memory." System › Health says the same. A failure never
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
  - In a review of only the owner's own messages, conventions learned from
    others, or from a thread that held others' messages, are left out of that
    review; turns still read them.
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
    others' messages were in the review, and a note whose review read rules
    learned from others reads as theirs. That is correct; person, forward,
    file, mixed and turn_read notes are marked as others' words, and a `nocheh`
    note is not the owner's own words either.
  - Small costs: one more parallel long-term memory read per owner turn
    (prefetched, with one guard check when it changes); one more recall ask; two
    records for an own message with a file; about 3,600 more characters per
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
  reminder, card, job report, notes, document, photo and voice scenarios.
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
    the messages it cites are (`rule_sender_not_allowed`). Such a rule still
    makes its note read as another person's, never the owner's.
  - A rule learned only from the owner's messages can restate a rule, or
    Honcho's chat, that its interpretation read, since its recorded inputs name
    neither.
  - Members: `canLearn` reads the owner's yes on a message before it checks that
    the chat is served. The notes review checks both; Members step 4 must close
    it in `canLearn`.
  - No test covers Hermes counting `forwards_unavailable` yet.
</consequences>
