# ADR-0139: Reply secret checks go before background learning checks

<status>
Accepted on 2026-10-12. Extends
[ADR-0127](0127-parallel-guard-checks.md); the owner-set number of checks at
once is unchanged.
</status>

<context>
After detector results were shared by text, a two-topic test made 16
secret-guard detector calls in two minutes. Nine came from background memory
reviews of the same turns and only three from guarding the replies' runtime
context. All of them shared the same three detector slots in arrival order, so
a reply's check could wait behind background learning that nobody was waiting
for. The owner chose to let replies go first.
</context>

<decision>

- Background memory reviews and contextual learning mark their detector
  calls as background. Every other detector call keeps the reply priority.
- A reply check waiting for a slot takes the next free slot before any
  waiting background check.
- Background checks use at most one slot fewer than the owner's setting, so
  one slot stays free for replies. With the setting at one, background checks
  still use that slot when no reply check is waiting.

</decision>

<consequences>
- A reply's secret check waits at most for checks already running, never for
  queued background learning.
- Background learning runs with one fewer slot and may take longer while
  replies are busy; it still finishes, since it takes free slots whenever no
  reply check is waiting.
</consequences>
