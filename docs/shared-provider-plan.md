# Shared provider execution and cutover

[SPECS.md](../SPECS.md) defines authentication, retry, speech, monitoring, and
embedding boundaries. [TASK.md](../TASK.md) records actual routing and acceptance.
ADR-0035 supplies the rationale. Follow [AGENTS.md](../AGENTS.md) for integration.

## Checkpoints

| Phase | Work and acceptance procedure |
| --- | --- |
| S1 — Contract | Inventory each consumer, credential owner, retry path, speech route, and monitoring boundary against the specification. |
| S2 — Provider service | Build the pinned service; verify private per-client credentials, single-owner refresh, locked no-fallback/no-extra-retry settings, and health. Fresh login remains a cutover gate. |
| S3 — Hermes, voice, and Honcho routes | Test every reasoning client through scoped shared-provider keys and current guard checks; verify speech has only read-only access-token access and Honcho retains its separate embedding meter and audience binding. |
| S4 — Monitoring | Build pinned CPA Manager Plus Full Mode; verify isolated state, owner session/CSRF proxying, credential protection, disabled automatic account actions, and failure isolation. |
| S5 — Local acceptance and cutover | Complete fresh login; run live reasoning, refresh, literal detection, Ogg/Opus speech, monitoring, and restart/recovery checks. Verify recovery-safe backup/restore and explicitly cut over only after success. |

The native Hermes subscription route remains active until S5 passes. Only after
cutover is the old native login an inactive rollback. Honcho attachment still needs
its independent live embeddings, ingestion, retrieval, and failure acceptance.
[Provider operations](provider.md) describes the commands; missing capacity or login
remains pending and does not prevent independent work.
