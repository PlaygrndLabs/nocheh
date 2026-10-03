<decision>

# 0095 — Recover an unstarted memory handoff on exact owner replay

<context>

[0094](0094-current-memory-authority-at-delivery.md) withholds a memory follow-up
whose approval links are incomplete. An older, interrupted handoff can already
have its exact action queued. If the worker cancels it before the owner replays
the decision, simply repairing those links leaves the message permanently stopped.

</context>

<choice>

Extend the owner-command recovery in
[0093](0093-atomic-memory-approval-followups.md). After validating the original
request, active grant, fact, wording, binding and automatic-follow-up setting,
an exact saved-decision replay may resume its action only when it was cancelled
before admission for missing delivery authority, has no execution security
decision and has no result reference. Reuse the same immutable action identity.

Make resumption an explicit option used only by that recovery path. Normal
trusted staging and automatic workflow retries cannot reopen a cancelled action.
Apply the current security policy, action resumption and both repaired links in
one control transaction. A denied recovery rolls everything back.

</choice>

<consequences>

Revoked, expired, changed or consumed grants do not qualify. A started or uncertain
effect cannot use this path; its existing native receipt is observed separately.
The durable native identity still prevents a duplicate physical send.

</consequences>

</decision>
