# ADR-0292: A chat's Hermes notes carry into new guard epochs

<status>
Accepted on 2026-11-24. The owner asked why Hermes's own notes are wiped on every safety
change and asked for a fix, and chose to keep the fresh start only for changes that take
something away from a chat. Amends [ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md),
[ADR-0168](0168-superseded-epoch-profiles-are-removed.md) and
[ADR-0257](0257-learned-memory-names-its-source.md), and closes the residual of
[ADR-0288](0288-one-agent-session-per-chat-per-day.md).
</status>

## Context

Each guard epoch gives a chat a new Hermes profile (ADR-0163). The conversation carries;
Hermes's own notes (`MEMORY.md`, `USER.md`) stayed behind, and ADR-0168 removed them with the
earlier profile 15 minutes later. Epochs move several times a day: a hide or restore, a
reaction, a learned rule, a memory correction, a people link, a settings change. So the agent
lost what it had noted many times a day.

Nothing chose this for safety: ADR-0163 carried the conversation only. But the drop did one
real job. After a change that takes something away from a chat (learning turned off, a group
un-shared or moved between projects, a memory grant revoked), a group's notes could hold what
the group may no longer see, and a fresh start removed it.

ADR-0129 already keeps a note out when it cites a hidden message or is what a withheld turn
wrote. The second check reads the writing turn from the profile's own `state.db`, which stays
behind in the earlier profile.

## Decision

1. **Storage records which chats keep their notes across each epoch.**
   `guard_notes_epochs(generation, epoch, keeps)` holds `all` or `owner`. An owner command
   says so with `OwnerCommands.run(..., {notes})`; the few places that move the epoch
   directly record it themselves.
   - `all`: hide or restore a message, a reaction, a yes to learning, an import review, a
     sharing approval, a group turned on, archiving an empty project, people suggestions, merges,
     renames and corrections, agent settings, memory settings and connection, learned rules, a
     learned memory correction, schedules.
   - `owner` (only the owner's private chat keeps them): un-sharing, project changes, a group
     turned off (the project's other groups stop reading it), moved between projects or
     organized, a chat's card, a revoked memory grant, undoing a merge, and a people suggestion
     that moves a sender from one person to another (a group can stop seeing the first).
   - No record, so every chat starts fresh: turning learning off, turning safety checks off
     or on, a new guarded copy or selection, runtime configuration, memory engine and operator
     changes. Any epoch not listed is unrecorded and also starts fresh.
2. **Hermes carries once.** When a chat's profile for a new epoch is first prepared, Hermes
   takes the newest earlier profile of the same chat. If that profile's own carry has not
   finished, it finishes first, so it holds the chat's notes as they stand. Hermes then reads
   its notes and, when there are any, asks storage (`POST /internal/notes/carry` with
   `generation`, `from`, `to`, `owner`, service token only). Storage says yes only when every
   epoch after `from` up to `to` keeps notes for that chat. Only the owner's private chat's
   own profile and groups carry. A member's private chat, a private answer and an ask about a
   member have no memory tool, and filtering writes no notes. Named and job profiles do write
   notes, but start fresh each epoch, as their conversation does (ADR-0163).
3. **What rests on a hidden message stays behind.** A note does not carry when it cites a
   hidden message or one whose answer is hidden, when it is what a turn the earlier profile
   would withhold wrote (ADR-0129, run on the earlier profile), or when what it rests on
   (point 4) is hidden.
4. **A carried note keeps what it rests on.** `nocheh-note-dependencies.json`, beside the
   notes, keeps per note (by its ADR-0257 key) the turns that wrote it (`turn`) and what they
   read (`sources`). A turn is the message it answered, from the stored rows and from the
   note's ADR-0257 origins, so a note rewritten by a later turn keeps its first writer. What
   it read: ids cited in its tool results, a quoted reply, earlier messages of the session it
   copied from, the notes review that wrote it, and the long-term memory the turn was given.
   No stored row holds that memory, so the turn sends its ids to the parent as soon as it reads
   them, and the parent records them after the turn, also when the turn stopped. Storage reads
   a review as hidden when any message it read is hidden, and a long-term memory record as
   hidden when anything it rests on is. A later turn drops the note when one of its `turn` ids
   is hidden or has a hidden answer, or one of its `sources` is hidden. It checks when the
   hidden-message revision changed since the file's `checked` value, or when a turn added a
   note. These go with a note on every later carry, so a hide two epochs later still removes it.
   On a group's carry, storage also names the facts the owner granted that the group can no
   longer read (`lapsed_grants`: the grant is not active or belongs to an earlier epoch), and a
   note resting on one stays behind. A lapsed grant hides nothing else: the owner's notes and
   stored history keep it.
5. **Order and locks.** Carried notes come first, the new profile's own after them, each once.
   The earlier profile is read while holding its turn and notes locks; the new one is written
   while holding its own, with Hermes's file lock and atomic replace. Each carried note keeps
   its source record (ADR-0257). Records and dependencies are saved before the notes, so a
   note never stands without them. Drift backups (`MEMORY.md.bak.*`) and review receipts are
   not carried.
6. **A carry that cannot finish now is tried again.** `.notes-carried` records the outcome.
   When storage or a lock is unavailable, a run still holds the earlier profile, or a notes
   record or dependency file cannot be read for now, the carry is tried again on the next
   prepare, and ADR-0168's removal keeps the earlier profile until then. A carry reads those
   files strictly, so a note never carries without what it rests on. A carry that can never
   finish (notes, paths, records or dependencies that are not what Nocheh wrote, a damaged
   database) or has failed for a day starts the notes fresh, so earlier profiles do not stay
   for good. Notes that cannot be read carry nothing. A no from storage starts the notes
   fresh, and removal goes ahead.
7. **Portable export carries the dependency file**, marked unchecked, so the first turn after
   a restore checks it again. An altered file stops the restore before anything is written.

## Consequences

- Hermes keeps its notes through the everyday safety changes, minus anything resting on a
  hidden message.
- A change that takes something away still starts notes fresh: in groups for project and
  sharing changes, everywhere for learning off and safety mode changes.
- A chat with no turn since an epoch change keeps its notes in the earlier profile; they move
  on its next turn, and the earlier profile is kept until then.
- A hide can now remove more than the hidden message's own notes: every note whose turn was
  given long-term memory resting on it. Before, a hide started every note fresh.
- Residual: a turn that starts in the earlier profile after the carry keeps what it wrote there.
- Residual: when Hermes rewrites a note, the new text keeps its ADR-0257 origins and its own
  citations, but not what the earlier text's turns read.
- Residual: a note that paraphrases a message or tool result without copying any of it, and
  cites nothing, escapes, as in ADR-0129.
- Residual: carried and new notes together can pass Hermes's size limit. Hermes still loads
  them and refuses new notes until it trims or replaces some.
