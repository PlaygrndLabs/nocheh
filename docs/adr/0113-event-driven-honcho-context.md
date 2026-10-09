# ADR-0113: Rebuild Honcho context when Honcho finishes work, not on a timer

<status>
Accepted implementation of the owner decision of 2026-10-09 recorded in
SPECS.md. Supersedes the two-minute refresh workflow and five-minute
usability limit of ADR-0044 and their renewal in ADR-0072. The cache key,
guard, audience and revision checks of ADR-0044 and ADR-0072 are unchanged.
ADR-0109, if accepted, later replaces the snapshot table itself.
</status>

<context>
Every generation kept a `context:` workflow that woke every 120 seconds
forever, so each idle generation added Inngest history all day. Replies used
the saved Honcho context only while it was under five minutes old. When that
loop fell behind, was paused, or failed once, replies reported limited memory
even though the generation was ready and its saved context was still correct.
The timestamp carried no meaning of its own: inside one generation nothing is
revoked, because every revocation advances the guard epoch and retires the
generation.
</context>

<decision>
- The context saved after a generation's last ready transition is current.
  Its age does not matter.
- The generation workflow rebuilds the context once Honcho has finished the
  generation's work, which is when the generation becomes ready.
- Freshness is checked when a message arrives. If the generation is ready and
  its saved context predates the last ready transition, the turn rebuilds it
  before use. If that rebuild cannot finish, the turn reports limited memory
  and requests a one-shot `context:` workflow for that work revision.
- While new work builds, the context saved after the last ready transition
  stays usable and the reply shows memory as syncing. A context older than the
  last ready transition is never used.
- The `context:` workflow runs once and completes. Nothing refreshes context on
  a timer, and no Honcho queue check happens on message arrival.
- Each rebuild checkpoint is keyed by the work revision and the ready
  transition, so recovery reuses only that transition's result.
</decision>

<consequences>
- A ready generation's memory no longer drops to limited memory because a
  timer fell behind.
- Idle generations stop adding Inngest history every two minutes.
- A message that arrives in the short gap between Honcho finishing and the
  rebuild pays for the rebuild in that turn; Hermes' 15-second context request
  may give up first, in which case that turn reports limited memory and the
  completed rebuild serves the next one.
- Recall still loses ready memory when an unrelated guard-epoch advance retires
  the generation. That is the per-generation workspace design, addressed only
  by ADR-0109.
</consequences>
