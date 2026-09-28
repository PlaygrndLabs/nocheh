# ADR-0073: Source-watched development uses the operating installation

Accepted by the owner, 2026-09-28. Implementation and activation evidence are
tracked in [TASK.md](../../TASK.md).

<decision>

`make dev` runs the operating `nocheh` Compose project with a source-watching
override from the session checkout. The unattended services are stopped before
this mode starts. It uses the same Telegram bot, Nocheh state, PostgreSQL and
Honcho volumes, and provider login. One Telegram poller and one provider
refresh owner run at a time. Development code changes compile and reload in
the running containers.

The launcher checks the main checkout's configuration, the exact operating
volume identities, rendered source and state mounts, and absence of another
running Nocheh stack before startup. The source-watching override explicitly
references the operating database volumes as external, so missing volumes fail
startup instead of creating empty replacements. Generated development code
volumes and images remain separate. Stopping development retains the live data
and credentials. A verified local backup precedes the first live switch.

This permits development code to modify live data; the owner explicitly
approved that risk. Source checks and live acceptance remain separate, and a
healthy development stack alone does not complete a release gate.

This supersedes [ADR-0066](0066-fixed-name-standard-port-development.md) on
the development project name, isolated state, credentials, and Telegram
polling. Its one-stack, normal-port, source-watching, and service-name
decisions remain in effect.

</decision>
