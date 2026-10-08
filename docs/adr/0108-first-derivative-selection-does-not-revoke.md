# ADR-0108: A first derivative selection does not revoke authorized contexts

<status>
Accepted implementation decision. Extends the first-representation exemption
of guard publication to derivative selections. Replacements are unchanged.
</status>

<context>
Live owner traffic showed replies retried two or three times and arriving up
to six minutes late. Activating the first transcript of a new voice note
advanced the single installation-wide guard epoch, so every in-flight turn
failed with `space_policy_changed` or `guard_context_changed`. A first guarded
copy was already exempt because no previously authorized content changes.
</context>

<decision>
A derivative selection revokes authorized contexts only when it replaces an
active selection (`expected_revision` is set). Activating the first transcript
or extraction for an artifact neither advances the epoch nor blocks the
publication fence. Its own reads still require the ready derived pointer.
Replacements, owner activations of another version, and learned publications
keep the global barrier.
</decision>

<consequences>
A voice note no longer interrupts other conversations while it is
transcribed. Contexts prepared before the transcript existed stay valid for
the content they used. Other global epoch advances, such as learned rule
replacements, still revoke in-flight turns and remain a separate concern.
</consequences>
