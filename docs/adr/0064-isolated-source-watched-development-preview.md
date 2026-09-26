# ADR-0064: Isolated source-watched development preview

Accepted by the owner, 2026-09-27. Implementation and verification evidence are in
[TASK.md](../../TASK.md).

<decision>

`make dev` starts a checkout-scoped Docker Compose Watch stack with the owned
PostgreSQL store, application API, owner dashboard, executor, security, Hermes,
speech, provider, monitor, and Inngest workflow services. Source edits rebuild
affected images and recreate their containers, using the development database
volume across rebuilds. The dashboard, API, and Python integration use the same
checkout's code.

The preview derives its project name from the checkout path and generates
credentials in that checkout's private `data/dev` state. Image names, network
names, and localhost ports are distinct from the operating installation. Pinned
local Hermes and provider image revisions are checked before their credential-free
contents become checkout-specific development images. No installation login is
copied and Telegram polling stays disabled. Optional Honcho and external model
activity require separate development credentials. Release acceptance remains
separate.

This extends [ADR-0019](0019-local-compose-development-and-acceptance.md)
with a safer development entrypoint and [ADR-0024](0024-single-environment-configuration.md)
with one generated configuration per preview.

</decision>
