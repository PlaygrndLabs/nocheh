<decision>

# ADR-0049: Initialize Inngest storage during application startup

Owner requested removing `inngest-db-init` and merging its work into another
service. This decision supersedes the separate initialization service in
[ADR-0046](0046-consolidated-inngest-installation.md).

`nocheh-app` provisions the dedicated Inngest database and restricted role before
opening its API listener. It already owns PostgreSQL administration credentials;
the Inngest image continues to receive only its dedicated database credential.
Compose starts Inngest after application and Redis health succeed. Application
health does not depend on Inngest connectivity, so engine outages cannot form a
startup cycle or prevent API/capture recovery.

Provisioning is idempotent and serialized by a PostgreSQL advisory lock. Existing
tables and history are preserved. Failed provisioning prevents startup and emits
only a generic error; the checked-out session is destroyed to release any lock.

Inactive restore invokes the provisioning CLI through the application image with
an explicit command override and `--no-deps`. It never starts the API, capture,
publisher or workers. There is no separate initialization Compose service.

Acceptance covers fresh Compose startup, concurrent provisioning and restart
without data loss, archive access denial for the Inngest role, startup while
Inngest is unavailable, and inactive workflow snapshot restore.

</decision>
