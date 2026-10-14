# ADR-0148: Honcho reads wait for each guard epoch's correction

<status>
Accepted on 2026-10-14. Refines the epoch correction sweep of
[ADR-0115](0115-honcho-session-revisions.md).
</status>

<context>
Honcho keeps one workspace across guard epochs. After an epoch, a bounded sweep
finds writes that became invalid, such as a retired message, rebuilds their
sessions, and deletes the old sessions with the conclusions derived from them.
Turns did not wait for that work. In the real-model simulator, a private turn
seven seconds after the owner retired both sources of a name answered the name
"from memory": the turn-start Honcho context still summarized the retired
message. Summaries, representations and recall answers carry no exact
citations, so nothing could filter them afterwards.
</context>

<decision>

- Turn-start Honcho context and `nocheh_memory_recall` read nothing from
  Honcho until the current guard epoch's `honcho` correction sweep is done and
  no replaced session of the workspace still waits for deletion.
- Meanwhile the turn is told that long-term memory is being corrected; current
  context, native notes, archive search and active owner corrections remain.

</decision>

<consequences>
Retired or otherwise invalidated material cannot reach a turn through Honcho's
uncited summaries. Every epoch change, including unrelated ones, makes Honcho
memory briefly unavailable until the sweep and any session deletions finish.
</consequences>
