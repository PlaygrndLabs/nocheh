# ADR-0032: Isolated upgrade checks and portable native memory

Accepted 2026-09-08. Extends ADR-0023, ADR-0027 and ADR-0030.

Nocheh owns the dashboard and supervisor. Hermes remains a pinned, replaceable
runtime adapter with its complete native page. Updates must preserve capture,
guarding, scope, approvals and the single Telegram/scheduler/OAuth authorities.

`nocheh compatibility check` builds a full commit into separate candidate images,
runs native contracts without network, credentials or live state, and builds the
patched native dashboard. It cannot activate a candidate or change the saved pin.
An offline pass is not live acceptance. Revision changes require reviewing the
compatibility patch, regression tests, inactive state rehearsal and live gates.

Backups preserve archive tables, original files, native state and durable operation
receipts. Native `.cache/uv` dependency caches are excluded and recorded as
rebuildable; unknown links outside that cache still fail validation. Restores hold
all archive workers, the tool worker and scheduler; Telegram
is disabled and the OAuth login is renamed. Snapshot-era pending work is preserved
for reconciliation because later deliveries cannot be inferred from a snapshot.
Removing holds is a deliberate cutover after reconciliation and source shutdown,
not a restore side effect. There is no automatic activation command.

Portable export includes the archive's original records/files and derived records,
plus registered native profiles' notes, scope markers and SQLite session databases.
SQLite backup includes committed WAL state. Original archive records remain the
source authority; native notes/history are labelled as runtime-generated material.
Per-file hashes and a completion manifest support independent verification. The
existing archive replay format remains nested unchanged.

Operational credential/configuration files are excluded. Exported conversations may
still contain secrets the owner put into those conversations; export preserves
their bytes. Profile reads and archive pagination are separate snapshots. Use a
quiesced full backup for a common recovery point, policy/approval state, credentials,
retired custom profiles and runtime recovery. Portable export does not activate or
reconstruct a working installation.

Rollback uses a verified snapshot and the matching prior code/images in a separate,
inactive installation. Do not run an older image against a newer live database or
start a second polling/refresh owner. Real Telegram release gates remain separate
from this tooling's automated and local acceptance.
