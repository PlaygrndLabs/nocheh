# ADR-0138: Identical runtime text reuses one detector result across audiences

<status>
Accepted on 2026-10-12. Extends
[ADR-0137](0137-side-by-side-runtime-context-guarding.md); guarded copies,
prepared values and access stay per audience.
</status>

<context>
After topics answered side by side, two group turns in different topics still
made 38 secret-guard detector calls (about 5 seconds each, three at a time)
within two minutes. Of the 544 runtime-context fragments they checked, 526 had
identical text already checked earlier the same day under another audience:
the same static turn-start context was detected again for every new topic, and
most tool outputs were repeats. The detection checkpoint was keyed by audience,
binding and text, so identical text under another audience always made a new
detector call, although the detector's answer depends only on the text.
</context>

<decision>

- When guarded runtime context needs detection, Nocheh first looks up a shared
  detector result for the same content hash, detector version and guard
  binding. A match supplies the literal spans; only unmatched fragments go to
  the detector.
- After a detector call, the first result saved for a text becomes the shared
  result. A concurrent different result for the same text keeps the first one.
- Each audience still records its own runtime-context derivative, detection
  checkpoint, guarded copy and prepared values, so reuse never makes text
  available to an audience that did not already hold it.
- A new guard epoch, binding or detector version starts with no shared
  results.

</decision>

<consequences>
- A new topic, group or purpose no longer re-checks the static turn-start
  context, and repeated tool outputs reuse earlier results.
- Detection of identical text is no longer independently repeated per audience;
  a detector miss on a text applies wherever that exact text appears in the
  same epoch, as it already did within one audience.
</consequences>
