# ADR-0097: Hand off native reviews without occupying workflow admission

<status>
Accepted implementation decision for personal-use simulation. Extends
[0087](0087-live-background-admission-handoff.md) and
[0088](0088-primary-ingestion-before-native-note-review.md).
</status>

<context>
A native note review can take minutes. Waiting synchronously for it retains the
only background operation slot, including after new source capture. Prioritizing
existing ingestion receipts does not help sources that have not yet reached
receipt creation. Outage recovery can therefore preserve the original while
delaying primary memory behind unrelated note work.
</context>

<decision>
The native review endpoint validates the capability and prepares the scoped
profile, then hands execution to one bounded supervisor thread. A global file
lock limits admission to one native review; the profile turn lock and existing
foreground quiet interval remain in force. Busy calls create no launch marker
and keep their existing prerequisite wait.

Before handing off, the parent fsyncs an immutable start marker under
`nocheh-review-runs` in its owned runtime state. A per-effect file lock identifies
the active supervisor. The journal records only identities and completion markers,
with no content or credentials, and is outside the isolated agent's mounts.
Only confirmed native completion creates the durable parent completion marker.

The endpoint returns `running` so the workflow releases admission and database
connections. Existing Inngest observation follows the same native review identity;
it never launches an already-started mutation again. Lost supervisors, failed
thread starts and missing completion remain ambiguous. Existing child receipts
can still confirm completion after loss of the parent receipt. Observation needs
neither provider credentials nor profile preparation.
</decision>

<consequences>
Capture preparation and primary ingestion can progress while native notes run.
The design adds no scheduler, retry identity, unbounded thread queue or model
implementation. A foreground turn using the same profile still observes its
ordinary serialization boundary. Existing quiesced backup covers the owned
runtime directory and checks for orphan writers; reset classifies its journal as
native runtime state. Native execution duration and actual memory quality remain
separate acceptance concerns.
</consequences>
