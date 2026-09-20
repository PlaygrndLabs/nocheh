# ADR-0055: Concise core service names

## Status

Accepted.

## Decision

Use `hermes` for the installation's single managed Hermes core, `hermes-agent-sb`
for the service that launches isolated agent sandboxes, and `nocheh-db` for the
PostgreSQL service that hosts Nocheh and Inngest databases.

These are Compose service and network host names. Database-domain names such as
`nocheh_archive`, `nocheh_derived`, `nocheh_control`, and `nocheh_inngest` remain
unchanged because they identify durable storage boundaries rather than containers.

## Consequences

Runtime URLs, dependencies, management commands, recovery logic, service
monitoring, compatibility fixtures, and current documentation use the new names.
Historical evidence and earlier accepted ADRs retain the names that were accurate
when those records were created.
