# ADR-0098: Reclaim abandoned native leases under the profile lock

<status>
Accepted implementation decision. Extends the isolated native turn boundary in
[0028](0028-isolated-native-browser-turns.md) and the review execution boundary in
[0097](0097-durable-native-review-handoff.md).
</status>

<context>
Pinned Hermes persists session-turn and compression admission leases in SQLite.
It conservatively keeps a lease whose recorded PID is alive. Separate isolated
containers can reuse that PID, so a killed turn can leave its successor waiting
for expiry. Repeated parent deadlines can prolong recovery even though the
original process no longer exists.
</context>

<decision>
Every managed isolated foreground and review process holds the existing mounted
profile `.memory.lock` exclusively for its complete execution. Only after taking
that lock, before native initialization, Nocheh reclaims the profile's abandoned
session-turn and compression admission rows in one SQLite transaction. The
kernel file lock is the cross-container proof that no preceding managed child
still owns those rows; PID liveness inside a new namespace is not that proof.

Recovery requires isolated mode and the owned `native-state` layout, never creates
a missing database, rejects symlink escapes, and validates both pinned table
schemas before deleting either table's rows. Failure prevents the turn. Native
lease acquisition, refresh, release, transcript fencing, messages, sessions,
compression lineage and review effect receipts retain their existing behavior.
Default profile locking outside this isolated startup path reclaims nothing.
</decision>

<consequences>
A replacement waits while a real profile owner holds the file lock, then can
recover immediately after that owner exits or crashes. This is admission-state
recovery, not permission to rerun an uncertain external effect or native review.
The design depends on every managed child retaining the same mounted lock for
its lifetime; widening profile access requires revisiting that invariant.
Cold context preparation and total turn latency remain separate concerns.
</consequences>
