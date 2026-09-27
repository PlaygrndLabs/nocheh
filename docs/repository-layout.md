# Repository layout and local state

Git contains source code, configuration needed to build and deploy it, documentation, and synthetic fixtures used by tests. Live conversations, acceptance reports, credentials, databases, generated builds, and local installation state stay outside Git.

| Tracked path | Role |
| --- | --- |
| `.agent/` | Shared agent skills and their references |
| `bin/` | Owner command launcher |
| `dashboard/` | Owner dashboard source |
| `deploy/` | Dockerfiles, Compose files, acceptance overlays, and pinned upstream revisions |
| `docs/` | Specifications support, decisions, procedures, and non-identifying status summaries |
| `services/` | Hermes plugin and Honcho service code |
| `src/` | TypeScript application services |
| `test/` | Tests and explicitly synthetic fixtures |
| `tools/` | CLI routing, operations, runtime helpers, acceptance harnesses, development tools, and build helpers |
| Root manifests and `AGENTS.md`, `SPECS.md`, `TASK.md` | Build inputs and authoritative project context |

The former top-level `compatibility/` mixed these roles. Its reusable scripts are under `tools/acceptance`, Compose overlays under `deploy/acceptance`, synthetic fixtures under `test/fixtures/acceptance`, and procedures under `docs/acceptance`.

| Ignored local path | Contents |
| --- | --- |
| `data/` | Installation state, credentials, upstream checkouts, and private acceptance output, including `data/acceptance/results/` |
| `node_modules/`, `dist/` | Installed dependencies and builds |
| `graphify-out/` | Generated development code graph |
| `results/`, `reports/`, `logs/`, `coverage/`, caches, local databases, `.env` | Generated output and machine-specific state |

Acceptance tools must create private outputs in ignored local paths with restrictive permissions. A committed status summary may describe a check without operational IDs, source content, credentials, or installation paths. The old tracked live reports were removed for privacy; historical claims that depended on them require fresh local-only evidence before release. Git-history cleanup and remote verification are tracked in [TASK.md](../TASK.md).
