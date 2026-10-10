# ADR-0124: Hermes native memory review runs once per source

<status>
Accepted on 2026-10-10 after the real-Claude simulator run spent most of an
owner-approved 1,000-call cap on Hermes native memory reviews after its
scenarios finished, with no new messages. Extends the durable native review handoff in
[ADR-0097](0097-durable-native-review-handoff.md) and the ingestion-first
ordering in [ADR-0088](0088-primary-ingestion-before-native-note-review.md);
Hermes' internal workflow is unchanged.
</status>

<context>
Every authorization epoch (a reaction, a rule or consent change, a guard
transition, a schedule or configuration change) requests a `memory_review`
refresh. The refresh sweeps the whole archive and asks for `source:<event>`
work on every source. That job prepares the source's native review input and
queues a `native:<id>` review whose identity includes the guard binding, so
each epoch created a new Hermes native review for every archived source. Each
review is an isolated Hermes turn with its own model and guard calls, and
reviews run one at a time behind the profile's quiet interval, so a few epochs
during a test left a long queue that kept calling the model.

A review whose start was never confirmed (a lost response, a stopped launcher,
a recreated provider) stayed `ambiguous` and was observed every 60 seconds with
no end. Relaunching it is refused by design: a missing receipt does not prove
that native notes were not written.

Honcho memory already writes each source once and asks only for sources it
never wrote after an epoch. Interpretation learning already skips an unchanged
context.
</context>

<decision>

- A source is reviewed by Hermes native memory once per installation
  generation. Queueing a source returns
  its existing review when any review of it has started, finished, is
  uncertain or paused, or is pending under the current binding. Only a source
  whose reviews all stayed pending under an earlier binding, and so were
  superseded before starting, is queued again under the current binding.
- An uncertain review is observed under its own identity at most eight times.
  Each observation that cannot confirm it waits twice as long as the last, from
  one minute up to 32 minutes. After the last one the review stays uncertain
  and its workflow closes as `ambiguous` with `native_review_unconfirmed`;
  nothing relaunches it. An owner resume observes it again with a fresh bound.
- Profile-busy waits are unchanged: they spend no attempt and keep the same
  identity.

</decision>

<consequences>
- After an epoch, the sweep costs workflow steps but no model call for sources
  already reviewed. New messages, and sources that become learnable only
  through a later consent or reaction, are still reviewed.
- A source's native notes are not refreshed when its surrounding context or a
  rule changes later; Honcho memory and learned interpretations carry those
  changes.
- An interrupted review can close without a confirmed result. Its notes, if
  any were written, stay in Hermes; the owner can see and resume it.
</consequences>
