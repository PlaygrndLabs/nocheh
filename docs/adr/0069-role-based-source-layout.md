# 0069 — Role-based source layout

Status: Accepted

## Context

The repository mixed owner commands, build helpers, acceptance tools, and service integrations under broad folders. Paths obscured which code was a product service, a plugin, or a development utility. Multiple launchers also made owner command discovery harder.

## Decision

`bin/nocheh` owns the owner-facing command surface. Python command routing and operational, runtime, acceptance, development, and build code use the corresponding `tools/` packages and absolute imports. A shared `tools.paths.ROOT` resolves repository assets.
Nocheh's `tools` package extends its module search path to include the pinned Hermes native `tools` package, preserving Hermes tool imports and its public availability check in the combined runtime.

Nocheh's Hermes plugin is `services/hermes`, alongside `services/honcho`. The singular `services` package avoids conflict with Hermes's upstream `plugins` package. Hermes still loads Nocheh through the `plugins/nocheh` profile link and the same plugin manifest identity. The owner dashboard source is `dashboard/`. Agent skills use `.agent/skills/nocheh-admin-cli` and `.agent/skills/nocheh-deploy`.

## Consequences

Repository file paths and Python import paths change. The `./bin/nocheh` command behavior, flags, output formats, privacy defaults, plugin identity, and stored data formats do not. Existing installations require a separate deployment and acceptance decision; this source layout does not activate them.

This decision extends [0025](0025-owner-dashboard-and-management-cli.md) and [0067](0067-exact-revision-app-rollout.md) on code ownership and launcher placement. It does not change their owner-operation or deployment boundaries.
