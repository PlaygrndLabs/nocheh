# ADR-0256: Nocheh's own messages carry a send class

<status>
Accepted on 2026-11-16, as the first part of the fourth set of fixes from the
review of how text from outside reaches Nocheh (risk 5, "Other people's text
becomes your private memory", fix 5e). The owner approved it on 2026-11-14 ("all
yes") with its wording: keep learning everything, but record where each piece
came from; Nocheh's cards and notices are not learned; job reports, scheduled
results and private answers are kept and labelled. Amends
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md): a
job's report is sent as `job_report` and learned, and the group's fixed line
about it is a `notice` and is not. Amends [ADR-0249](0249-answer-privately.md):
a private answer is learned, as `private_answer`. Keeps
[ADR-0238](0238-record-every-send-to-a-chat-app.md): send records keep their
kinds. The memory half, which labels each learned note by these classes, is
[ADR-0257](0257-learned-memory-names-its-source.md).
</status>

<context>
- Every message Nocheh sent that Telegram returned was archived as a delivered
  message and learned like any other, by the notes review, by long-term memory
  and by interpretations. That included approval cards and their edits,
  refusals, notices and task reminders.
- A card or a reminder can quote what someone else wrote: a member's job
  instruction, a task title a person set. Learned as Nocheh's words in the
  owner's private chat, that text reached the owner's notes and what long-term
  memory knows about the owner.
- Nothing in an archived delivered message said what kind of send it was. The
  dispatch key's prefix said it only while the send ran, and one prefix covered
  more than one kind (a control reply is a card or a `/start` refusal).
</context>

<decision>

## The classes

- `src/send-classes.ts` lists eleven neutral classes, with no app words.
  `reply`, `follow_up`, `private_answer`, `job_report`, `scheduled_run` and
  `approved_post` are learned. `card`, `card_update`, `refusal`, `notice` and
  `reminder` are not (`unlearnedSendClasses`). `services/telegram/sends.py`
  holds the same list (`SEND_CLASSES`), and a test keeps the two equal.

## Stamped where the send is decided

- Each route of the Telegram gateway sets the class beside its dispatch key,
  from what its caller declared, else its own default:
  - a reply accepts `reply`, `follow_up`, `private_answer` or `card`, default
    `reply`, and also records the message it answers (`answers`, a full event
    id the route already checks against its dispatch key);
  - an approved send accepts `approved_post`, `job_report`, `scheduled_run` or
    `notice`, default `approved_post`;
  - a notice accepts `notice` or `reminder`, default `notice`;
  - an approval card is `card`; its settle, a button answer and a notice edit
    are `card_update`; a refusal is `refusal`.
  An unknown class falls back to the route's default and never refuses a send.
  Send records keep their kinds.
- Callers declare it. The dispatcher works out a reply's class when the reply
  is sent (a fixed control reply is `card`, a private answer `private_answer`,
  anything else `reply`), never in the turn's stored input, so turns in flight
  keep their hash. Follow-ups are `follow_up`; task reminders are `reminder`. A
  model's send request is `approved_post` and a scheduled result
  `scheduled_run`. A system send must name its class (`prepareSystem`): a job's
  report `job_report`, the group's line about it `notice`, the memory-access
  notification `notice` and its follow-ups `approved_post`.
- `telegram_action_requests.send_class` (added if missing, checked against the
  four values) keeps an approved send's class. An older row has none and is sent
  as `approved_post`. The class is not part of an action's id.

## Carried in the delivered payload

- The capture adds `send_class` and `answers` to a send's result, each only
  when it is valid, and never to its outbound key, so duplicate checks and
  replay are unchanged. `src/stores/generated-capture.ts` copies them into the
  archived `telegram_delivered_message` payload, `{message, send_class?,
  answers?}`. A result with neither archives exactly as before, so a spool
  drained across the deploy keeps its source identity.
- A missing class means learn. Everything archived before this change, and the
  web chat's replies, which carry no class, are learned as before.

## Read in one place

- `access.notLearned(source)` answers `nocheh_message` for a delivered message
  whose class is not learned, unless the owner turned learning on for that
  message: a consent yes overrides.
- The memory workflows' `sourceReady` asks it right after `canLearn`. The notes
  review, the Honcho write, the ingest requeue, the sweep after a change and
  the rebuild requeue all close such a source as `skipped` with
  `nocheh_message`, and a notes review still waiting for it is withdrawn. A
  notes review queued before the deploy is withdrawn when it would run
  (`reviews.unwanted`).
- It is never in `canLearn` or in the Honcho receipt check. A card stays
  context for the owner's reply to it, and what was written to Honcho before
  stays valid, so nothing is rebuilt.
- The message's learning setting reads off, with authority `send_class`, until
  the owner turns it on. System › Background work says "Nocheh's own card,
  notice or reminder: kept, not learned".
- `notLearned` returns a reason, so the Members design's session taint (step
  4b) plugs in there.

</decision>

<alternatives>
- **Skipping in `canLearn`.** Rejected: a card would stop being context when the
  owner replies to it, and old Honcho writes would read as invalid and be
  rebuilt.
- **Refusing a send with an unknown class.** Rejected: the class is a label for
  memory, and a send that works today must not fail on it.
- **Reading the kind from the dispatch key at learning time.** Not possible: the
  archived message does not keep the key, and one prefix covers more than one
  class.
- **Putting the class in the outbound key.** Rejected: it would change duplicate
  checks and replay for sends already in the journal.
</alternatives>

<consequences>
- Cards, card updates, refusals, notices and reminders stay in the archive and
  search, and stay context when the owner replies to one, but no longer reach
  the owner's notes, Honcho summaries or interpretations.
- Honcho no longer sees what a "done" reply answered when it answered a
  reminder. A task made on the dashboard, whose reminder was its only chat
  trace, no longer reaches Honcho; the task itself still holds it.
- Replies, follow-ups, private answers, job reports, scheduled results and
  approved posts are learned as before, and ADR-0257 labels each by its class.
- The owner can still have one card or notice learned by turning learning on
  for it.
- **Residuals:**
  - The dashboard has no page for one message's learning setting yet, so the
    `send_class` reason shows only through the owner API.
  - Web-chat replies carry no class. They are Nocheh's replies and are learned,
    as before.
  - A button answer leaves no archived message, so its class is only on the
    send.
</consequences>
