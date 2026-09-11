# ADR-0036: Keep local services in one Compose project

Accepted by the owner, 2026-09-09. Implementation status is in `TASK.md`.

Run the native Hermes dashboard container in the main `nocheh` Compose project.
The dashboard remains a separate service with its own read-only filesystem,
capability restrictions, state mount, health check and loopback port. Its failure
does not block the archive, provider, Hermes or worker services.

The owner management server remains a host process because it performs local
owner-authorized operations without exposing the Docker socket to a container.
`./scripts/nocheh dashboard --stop` shuts down that process and stops only the
`dashboard` service. Normal `up`, `down`, `status`, rebuild and cleanup operations
now cover every Nocheh container through the single `nocheh` project.

Remove the former `nocheh-dashboard` project after the first rebuild. This decision
supersedes only the separate Compose-project packaging in ADR-0025 and ADR-0027;
their ownership, authentication and failure-isolation boundaries remain active.
