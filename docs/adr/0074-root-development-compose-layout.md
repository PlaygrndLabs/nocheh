# ADR-0074: Root development Compose override

Accepted by the owner, 2026-09-28. Implementation evidence is tracked in
[TASK.md](../../TASK.md).

<decision>

The operating source-watched development override lives at the repository root
as `docker-compose.dev.yml`, beside the operating `docker-compose.yml`. The
`make dev` launcher combines them with the operating storage overlay, retaining
its checks for project ownership, source and state mounts, external volume
identities, ports, and a single running Nocheh stack. The existing app service
continues to compile mounted source and trigger live reload.

The isolated automated-test override lives in `deploy/acceptance`. The older
isolated development preview launcher and Compose override are retired. Their
separate local state and volumes are not deleted by this source cleanup.

This refines [ADR-0073](0073-live-data-source-watched-development.md) on file
placement and removes the superseded preview entrypoint without changing the
accepted live-data development boundary.

</decision>
