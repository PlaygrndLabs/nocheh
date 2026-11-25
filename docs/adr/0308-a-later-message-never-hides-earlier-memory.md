# ADR-0308: A later message never hides memory read before it

<status>
Accepted on 2026-11-25. This fixes a bug the tester found in
[ADR-0292](0292-chat-notes-carry-into-new-guard-epochs.md): hiding one message dropped every Hermes note in the chat,
not only the hidden message's own. It amends
[ADR-0261](0261-recalled-facts-and-search-hits-name-their-source.md) (B6.2, a record resting on a retired message).
</status>

## Context

A record of long-term memory that a turn read counts as hidden when a message it rests on is hidden (ADR-0261 B6.2).
A fact that names only some of its session's messages counts as resting on the whole session. Before this fix, that
meant every message ever written to the session, including messages written after the record was made.

The owner's private chat writes each message to the same memory session. So hiding a message marked as hidden every
earlier record that held such a fact. ADR-0292 drops a carried note when the long-term memory its turn read is hidden,
so one hide dropped every note whose turn had read the chat's memory.

## Decision

A hidden message counts against a record through its session only if it was written to that session before the record
was made (`memory_ingestion_receipts.created_at` before `derived_artifacts.created_at`). A record cannot rest on a later
message. Evidence the record names itself is unchanged. `SourceRetirementRepository.retiredSessions` returns each
session with its first write of a hidden message, and `retiredRecords` compares it with the record's own time.

## Consequences

- A hide drops only the notes that rest on the hidden message, or on memory read after it was written.
- Stored history (B6.2) and opening a fact follow the same rule, so a fact read before a message was said stays open
  when that message is hidden.
- The tester scenario `notes_survive_a_hide` checks it end to end. `store-fact-opening` checks a message written after
  the records.
