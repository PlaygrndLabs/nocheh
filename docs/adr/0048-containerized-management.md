<adr>

# ADR-0048: Containerized dashboard and executor

<decision>

The owner's 2026-09-16 instruction moves the dashboard and executor into Docker
and requests cleanup and rebuilt services. They are separate services in the same
installation Compose project, supervised in the foreground, using the pinned
Node 24 runtime and thin Python adapters. Internal calls use Compose DNS; public
dashboard and OAuth callback listeners are published only on host loopback.
This supersedes the host-process placement in ADRs 0036, 0041, 0042 and 0046.
Backups and recovery remain independent of the application and Inngest, but need
the Docker engine. The CLI remains usable from the host if Docker is unavailable.

</decision>

<administration_boundary>

The owner explicitly approved Docker-socket access for `nocheh-dashboard` and
`nocheh-host-executor` after being informed that it grants control over all local
Docker resources. Both trusted administration services mount the socket and use
its group (`NOCHEH_DOCKER_GID`, default 0); they run as the installation user.
This authority supports backups, restarts, monitoring and approved isolated tools.
It is outside the agent isolation boundary. Isolated agents and tool sandboxes
receive no Docker socket, and retain their network and filesystem restrictions.

The image contains the application and runtime dependencies. Installation paths
are mounted at their original absolute paths so daemon-side bind mounts, settings,
imports and backups refer to the intended installation. No runtime credential is
copied into an image. State and accepted execution identities are preserved.

</administration_boundary>

<acceptance>

Build the management image, validate Compose, and use synthetic state to check
container startup, the owner/native/provider proxies, session and origin checks,
independent dashboard availability, executor reconnection and receipt recovery,
inactive restore and graceful shutdown. Verify maintenance and approved tool
isolation through the authorized administration boundary. Before local cutover,
snapshot and drain the host executor and dashboard, then start one container of
each. Rebuild the installation, verify health and subscription transcription,
and remove only obsolete Nocheh resources. Never prune volumes or other projects.
Record actual results in [TASK.md](../../TASK.md).

</acceptance>
</adr>
