<decision>

# 0096 — Serialize memory decision replays and preserve expiration

<context>

The atomic handoff in [0093](0093-atomic-memory-approval-followups.md) preserves
one grant and follow-up. Its receipt lookup precedes the transaction, so two
identical concurrent commands can both miss the receipt. The losing command then
reports a database uniqueness error or a changed request instead of the saved
result. Manual grant identities also omit the optional expiration, allowing a
changed deadline to be silently treated as an exact retry.

</context>

<choice>

Serialize memory decisions by operation identity with a transaction advisory
lock before taking request or guard locks. Recheck the durable receipt after
acquiring that lock. An identical command returns the saved result; a different
command conflicts. Approval, rejection and manual grants share this lock domain.
Representation preparation remains outside control locks.

Compare a replayed manual grant's expiration instant, including an absent bound,
with the saved grant. Equivalent timestamp representations name the same instant.
Preserve existing command hashes and grant identities, including historical
normalized-wording receipts; no authority migration or reactivation is needed.
Return the same rejection receipt shape for first execution and retries.

</choice>

<consequences>

Database-backed overlap tests force both callers to miss the initial receipt.
They cover identical manual grants, approvals and rejections, conflicting
deadlines, and an approval racing a rejection under one identity. Changed-expiry
replays leave the original bound untouched. Existing revocation, delivery and
legacy-recovery checks still apply.

</consequences>

</decision>
