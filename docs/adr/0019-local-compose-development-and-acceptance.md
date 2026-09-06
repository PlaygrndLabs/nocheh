# ADR-0019: Local Docker Compose is the current deployment target

Accepted, 2026-09-06. Amends ADR-0018's VPS sequencing; preserves its product and
data decisions. The owner has no VPS and explicitly requested local development
and automated startup using the same Docker Compose stack.

## Decision

- Local subscription compatibility completes Phase 1: native login/refresh, chat,
  literal detection and Ogg/Opus transcription passed live; failure contracts pass.
- Phase 2 provides the shared Compose stack for local development and normal
  unattended operation. Containers own service dependencies and persistent state.
- Local Compose acceptance replaces VPS acceptance for this rebuild and merge.
  Verify live subscription inference and transcription again inside the containers.
- VPS provisioning and verification are deferred until a server exists. Preserve
  portable Compose configuration and document the later deployment procedure.
- Keep automatic phase progression, commits and all data/guard/scope/durability
  requirements. A failed required local transcription check still blocks release.

This is an explicit change in acceptance scope, not evidence that a VPS was tested.
