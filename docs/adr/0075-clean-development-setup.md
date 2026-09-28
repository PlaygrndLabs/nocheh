# ADR-0075: Clean development setup

Accepted by the owner, 2026-09-28.

<decision>

Root `docker-compose.yml` directly defines the three-store runtime and creates
project-owned volumes. Root `docker-compose.dev.yml` adds source watching from
the session checkout. The separate storage overlay and legacy runtime entrypoints
are removed. Initialization uses `.env` directly without importing retired setup
sidecars. Synthetic acceptance fixtures remain under `deploy/acceptance`;
shared repository regression fixtures do not provide an alternate app startup.

The owner requested a fresh pre-release installation, removal of old containers
and application data, preservation of credentials and settings, and development
startup. This reset is an explicit operation; normal development restarts retain
data. Spending limits retain their accounting across a reset.

This supersedes [ADR-0074](0074-root-development-compose-layout.md) on the storage
overlay and external-volume requirement and [ADR-0073](0073-live-data-source-watched-development.md)
on requiring pre-existing databases before development. Source watching, one
local stack, and service/port/provider ownership checks remain required.

</decision>

<verification>

Current results and pending acceptance are recorded in [TASK.md](../../TASK.md).
A clean restart does not establish release acceptance.

</verification>
