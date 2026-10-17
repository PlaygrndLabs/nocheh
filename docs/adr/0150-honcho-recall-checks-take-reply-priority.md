# ADR-0150: Honcho recall checks take reply priority

<status>
Accepted on 2026-10-16. Extends
[ADR-0139](0139-reply-checks-before-background-checks.md).
</status>

<context>
In the October 15 simulator run each real Honcho recall took 25 to 36 seconds,
and Nocheh's secret check accounted for about 11 to 21 seconds of it. A recall
makes about five sequential checks: the question, the request before each of
Honcho's two reasoning rounds, and the answer. Every request from Honcho to the
provider gateway was prepared under the workspace's memory-review principal, so
its checks ran at background priority, behind reply checks and inside the
background share of detector slots, even when Honcho's API was answering a
recall for a waiting reply. Honcho's deriver, which learns from new messages
while that reply runs, competed for the same background share.
</context>

<decision>

- Honcho's deriver marks its gateway requests as background; requests from
  Honcho's API, such as recall reasoning and search embeddings, carry no mark.
- The provider gateway forwards the mark to Nocheh's preparation, which checks
  marked requests at background priority and unmarked requests at reply
  priority, independent of the memory-review principal used for their prepared
  audience.

</decision>

<consequences>
Recall reasoning no longer waits behind background learning and derivation
checks. Background derivation still leaves one detector slot for replies.
Detector calls per recall and their duration are unchanged.
</consequences>
