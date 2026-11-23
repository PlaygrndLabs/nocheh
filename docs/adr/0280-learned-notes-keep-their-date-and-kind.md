# ADR-0280: Learned notes keep their date and their kind

<status>
Accepted on 2026-11-23. A full re-learn after [ADR-0275](0275-honcho-3-6-2-and-reading-instructions.md)
showed two faults. Amends 0275's reading instructions and the write time of
[ADR-0257](0257-learned-memory-names-its-source.md) records.
</status>

## Context

- Nocheh writes each learned note (a `learned_interpretation` record, and the `entity_evidence`
  made from it) to Honcho with a time. A plain message took its event's time. A note took none,
  so Honcho dated it by the write. A re-learn writes every note again, so every note read as new,
  and Honcho resolved "today" or "Thursday" in it against the re-learn day.
- 0275's first rule said every record holds words Nocheh wrote, and its third rule said Nocheh's
  own messages hold other people's words. Honcho read every learned note as Nocheh's words about
  someone else and drew no observation from most of them. Rules people set in a chat were lost.

## Decision

1. **A note's date.** `occurredAt` in `src/stores/native-memory.ts` dates a write by:
   - a message: its event, as the archive orders it (`sourceMoment`);
   - an owner correction: when the owner wrote it (`learned_versions.created_at`);
   - any other note: the message that set off its learning (the trigger event of its learning
     result), else its latest evidence.
   No note is dated by its write.
2. **Reading instructions.** `readingInstructions` in `src/memory/honcho.ts` now says:
   - a record's `source` or `kind` says whose words or conclusions it holds;
   - a `source` names each part of a message, separated by "; ", and only a part named the
     sender's own words or transcribed voice or video note holds the sender's words;
   - a record whose `source` begins with "Nocheh's" (a reply, follow-up, private answer, report,
     scheduled result, post or note) holds other people's words, like a forward; a learned note
     is no longer read that way;
   - a `learned_interpretation` by the owner is a fact that replaces earlier notes on the same
     thing; one by a participant (backed by a quote from a message it cites) is kept within its
     scope as a standing rule (a convention), a fact (a meaning) or true on its date (a state),
     without naming who said it; any other note is kept at most as "Nocheh inferred", with its
     uncertainty;
   - a note is never anyone's own words, and no health, sexual or other sensitive personal state
     is kept from a note.
   `openSpace` sends the new text to each space once, as in 0275.

## Consequences

- New writes follow both rules. Notes written before keep their dates and Honcho's conclusions
  from them until a re-learn, which needs the owner's yes.
- The instructions stay under Honcho's 2,000-token budget for them.
- Known limit: learning may cite a reply written after the message that set it off (an import,
  or work that ran late). A relative date taken from that later reply still reads against the
  earlier day. The learning context carries no message times, so a note cannot write absolute
  dates itself.
