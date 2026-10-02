# ADR-0083: Defer automatic memory publication during replies

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0080](0080-reply-admission-and-honcho-derivation.md) on foreground progress and
[0082](0082-evidence-based-learning-deduplication.md) on automatic learning.
</status>

<decision>
An automatic interpretation batch that publishes any learned version waits
while a Telegram dispatch is running under the same installation and guard epoch,
or a browser/scheduled run has a current running lease under that binding. The
check occurs before the batch advances the guard epoch or creates publications.
The interpretation job remains pending, and Inngest schedules its next check.
The saved reasoning result and staged versions are reused on retry.

First publications also wait because their publication barrier temporarily
blocks guarded reads even without advancing the epoch. Owner corrections, source
guarding, retirement, consent, and other privacy
revocations remain immediate. A revoked Telegram binding or expired managed lease
does not hold up automatic publication. Existing authorization checks still catch
an admission/publication race; this scheduling preference does not grant authority.
</decision>

<consequences>
Background reinterpretation does not deliberately revoke an already admitted
reply. Continuous or unreconciled foreground execution can delay automatic memory
publication; durable execution recovery remains responsible for its final state.
Automatic learning is not disabled, and new evidence is not discarded. This does
not eliminate model failures, shorten provider waits, or establish recall quality.
</consequences>
