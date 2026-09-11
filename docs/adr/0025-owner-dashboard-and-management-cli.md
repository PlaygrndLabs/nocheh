# ADR-0025: owner dashboard and management CLI

Status: accepted. Date: 2026-09-07.

Implement the owner's requested dashboard in separate verified commits, following
[the implementation plan](../dashboard-cli-plan.md). Reuse the pinned Hermes web
dashboard extension API and official Honcho data CLI where compatible.

Nocheh `.env` remains authoritative for deployment, guard, route and Telegram
policy. Native profile YAML retains supported preferences across turns; the
resolver enforces Nocheh-owned values, and the assistant consumes validated native
reasoning/iteration/budget preferences. Limit the turn budget to 180 seconds to
remain within existing dispatcher deadlines.

Dashboard HTTP runs separately from the Telegram supervisor. Its native backend
uses an isolated home without provider credentials or bot credentials; its routes
are restricted to the dashboard shell and Nocheh extension. Disable native chat,
gateway lifecycle and unrelated mutation APIs at the server boundary. A local
TypeScript management service provides authenticated owner operations through
enumerated Python adapters. No Docker socket or archive bearer token reaches the
browser. Authentication/refresh remains in the native supervisor.

The dashboard and CLI share configuration and job operations. Stored secrets are
write-only in management responses. Atomic changes have revision checks and an
apply/recovery operation. Historical imports remain silent. Memory and graph
queries preserve chat scopes; explicit citations are distinguished from missing
provenance. Honcho stays isolated and optional under ADR-0022.
