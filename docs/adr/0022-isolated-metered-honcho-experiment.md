# ADR-0022: isolated, metered Honcho experiment

Status: accepted for the optional comparison; live results pending.
Date: 2026-09-07.

Honcho requires embeddings separately from its reasoning route. Run its API,
deriver, Redis and PostgreSQL in a separate Compose project with synthetic data.
Reuse the pinned Hermes image as a native-memory baseline, with independent
profiles. Do not mount production archives, Telegram credentials, or OAuth stores.

Use a separate CLIProxyAPI device login for subscription reasoning. The internal
meter permits only the selected subscription model and the explicitly selected
paid embedding model. Its durable SQLite ledger conservatively reserves $0.01
before each bounded paid attempt and stops at $5, including retries, failures and
uncertain responses. No paid reasoning fallback is configured. The ledger survives
ordinary Compose teardown and spans all experiment runs.

Measure answer matches, source-label matches, latency, upstream usage and failures
on a fixed synthetic dataset. Preserve incomplete runs. These measurements are
limited smoke evidence, not a broad memory-quality claim. Missing experiment
credentials do not block the production release. See the
[runnable comparison](../../experiments/honcho/README.md).
