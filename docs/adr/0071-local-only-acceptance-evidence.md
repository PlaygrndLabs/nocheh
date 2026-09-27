# 0071 — Local-only acceptance evidence

Status: Accepted

## Context

The repository committed live acceptance result files as review evidence. Some carried event and reply identifiers, source-related fields, and installation details. A tracked report makes those values part of every clone and of Git history, even after a later file deletion.

## Decision

Git tracks source code, build and deployment configuration, documentation, and explicitly synthetic test fixtures. Reusable acceptance code lives under `tools/acceptance`, Compose overlays under `deploy/acceptance`, synthetic fixtures under `test/fixtures/acceptance`, and procedures under `docs/acceptance`. Runtime state, generated output, and live reports write only to ignored local state under `data/` or another ignored output directory, with restrictive permissions where private material may appear. Repository status may summarize a check without source content, operational IDs, credentials, or installation paths. Old tracked reports are removed from the tree and purged from reachable Git history before any remote synchronization.

## Consequences

Historical live claims whose reports were removed require fresh local-only evidence before release. Git history must be rewritten to remove the old blobs; deletion in a new commit alone does not do that. Collaborators and remote mirrors need to replace old refs after a successful rewrite, and compromised credentials require rotation independently of Git cleanup.

This extends [0040](0040-specifications-and-agent-workflow.md) on evidence retention. It does not change product data retention inside Nocheh's owned stores.
