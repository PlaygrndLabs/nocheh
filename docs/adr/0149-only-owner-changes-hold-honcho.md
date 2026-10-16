# ADR-0149: Only uncorrected owner changes hold Honcho reads

<status>
Accepted on 2026-10-15. Supersedes the epoch condition of
[ADR-0148](0148-honcho-reads-wait-for-epoch-correction.md).
</status>

<context>
ADR-0148 held Honcho reads until the current guard epoch's correction sweep
finished. Learning publications and other routine work also advance the epoch,
often faster than a sweep completes, so in the simulator Honcho memory stayed
unavailable for the entire run and every reply said memory was limited.
</context>

<decision>

- Turn-start Honcho context and `nocheh_memory_recall` read nothing from
  Honcho while an owner command (such as retiring a message or withdrawing
  learning consent) has an epoch later than the newest finished `honcho`
  correction sweep of the installation, or while a replaced session of the
  workspace still waits for deletion.
- Other epoch changes do not hold Honcho memory.

</decision>

<consequences>
Retired or withdrawn material still cannot reach a turn through Honcho's
uncited summaries. Memory pauses only after owner changes, until a sweep at
that epoch or later finishes.
</consequences>
