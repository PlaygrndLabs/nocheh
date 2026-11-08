# ADR-0217: Waiting fragments of a long source keep their place

<status>
Accepted on 2026-11-08 after the change of
[ADR-0216](0216-failed-reviews-keep-their-place-across-epochs.md) went live on
the owner's development install, and its first sweep deleted the failed review
it was meant to run again. Amends
[ADR-0124](0124-native-review-once-per-source.md); extends
[ADR-0173](0173-waiting-native-reviews-keep-their-place.md) and ADR-0216.
</status>

<context>
A source whose prepared input is longer than 8,000 characters is reviewed in
fragments, one Hermes native review each. Every fragment carries the whole
source's evidence: the source, the message it answers, and that message's
replies and reactions. ADR-0124 reviews a source once, so
queueing it again returns its existing reviews as soon as one of them has
started, finished, is uncertain or paused, or waits under the current binding.
That check counted the source's own other fragments. When an epoch landed
after one fragment had run, the source's next step kept that fragment and
deleted every other fragment still waiting under the earlier epoch. Before
ADR-0216 this cut short only fragments that never started; ADR-0216 made it
delete fragments that had failed once as well. Those parts of the source were
never reviewed.
</context>

<decision>

- Once a fragment of a source has started, finished, is uncertain or paused,
  or waits under the current binding, the source gets no new fragment, as in
  ADR-0124.
- Its other fragments still waiting under an earlier epoch, never started or
  failed without changing notes, are renewed when their prepared input is
  unchanged: same identity, attempts, last failure, gap and place, as in
  ADR-0173 and ADR-0216.
- A new reply or reaction in the thread changes every fragment's evidence. A
  waiting fragment whose own text is unchanged is then replaced by a fragment
  with the current input, which keeps its attempts, last failure and gap.
- A waiting fragment whose own text changed is deleted, and nothing replaces
  it, because a new fragment could repeat parts that other fragments already
  reviewed. So is every waiting fragment when the source can no longer be
  prepared (its learning consent is gone or its input is over the limit).
- A source with no waiting fragment under an earlier epoch is not prepared
  again, so the sweep after each epoch still costs no model call for it.

</decision>

<consequences>

- A long source is reviewed in full across any number of epochs and new
  replies in its thread. A waiting fragment whose own text changes, usually
  the last one, which holds the chat's rules, is not reviewed.
- A fragment deleted before this change, such as the one on the development
  install, is not queued again; a source keeps the fragments it has.
- The source's step prepares the input again only while it still has
  fragments waiting under an earlier epoch.

</consequences>
