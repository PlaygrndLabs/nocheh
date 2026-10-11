# ADR-0130: Guard fragments leave once their source is prepared

<status>
Accepted on 2026-10-10. Extends
[ADR-0113](0113-superseded-memory-summary-retention.md) and
[ADR-0121](0121-operational-telemetry-retention.md) with one more derived-store
pass of the same daily retention worker.
</status>

<context>
Preparing a guarded copy splits its text into bounded fragments and saves each
fragment's guarded result before continuing, so an interrupted preparation
resumes without repeating detector calls. A guard source is prepared once:
after its revision is published (`active_revision` set), preparation returns
early and never reads its fragments again. Nothing removed them. One simulator
run of 180 archived events left 228,823 fragments (97 MB), mostly copies of the
same runtime-context text under per-binding sources.
</context>

<decision>

- The daily retention worker removes fragments whose source has a published
  revision, in bounded batches, using the administrator role like the Honcho
  summary pass (the derived runtime role cannot delete).
- A fragment younger than one hour is kept, so a preparation that is still
  finishing keeps its checkpoints. Fragments of unprepared sources stay.
- The pass runs whenever workflow history retention is on (14 days by
  default); setting retention to `0` keeps every row, as for the other passes.

</decision>

<consequences>

- Fragment storage is bounded by sources still being prepared.
- Guarded revisions, the authoritative guarded copies, are unchanged.
- Complete portable exports no longer carry fragments of prepared sources,
  which a restore never needed.
</consequences>
