# ADR-0170: Secret-check results carry across guard epochs

<status>
Accepted on 2026-10-26, when the owner said "yes for all" to the slow-reply
follow-up after the release test rerun. Narrows the shared detector reuse in
the runtime context preparation.
</status>

<context>
In release test 4, the first reply after hiding a message took 94 seconds. Of
that, 50 seconds went to one long-term memory recall. About 7 seconds of the
recall was checking the question and the answer. Honcho's three reasoning
rounds also left about 19 seconds between them, waiting on secret checks of
their prompts. That turn ran 633 secret checks, against 117 to 338 in other
turns.

Each check result was shared by text across audiences, but it was keyed by
the full guard binding, including the epoch. Every hide, restore, correction,
learning revision or reaction advances the epoch. So after each of them, text
that had already been checked, such as Honcho's conclusions, was sent to the
detector model again.
</context>

<decision>
- The shared secret-check result for a text is keyed by the installation
  generation, guard mode, detector version and the text, not by the epoch.
  Text already checked in an earlier epoch reuses that result.
- Prepared values, guarded copies and per-audience checkpoints stay per
  audience and per epoch. Retired content is still withheld by the epoch's own
  preparation, as before.
</decision>

<consequences>
- After a memory change, replies and memory recall check only text that has
  never been checked before, so the first replies after a change are no
  longer slowed by re-checking everything.
- A change to the owner's secret-check instruction applies to text not yet
  checked. Within one epoch this was already the case.
- Results saved before this change are not reused, so each text is checked
  once more.
