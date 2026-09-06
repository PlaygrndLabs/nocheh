# Nocheh

A personal assistant built around Hermes, with an independent archive of original
messages, events, files, and transcripts. Source data remains portable when the
agent or memory system changes.

**Status:** rebuild in progress on `codex/hermes-rebuild`. The legacy implementation
is preserved on `codex/legacy-nocheh`. The source/runtime has not been replaced yet;
Phase 1 must prove subscription chat and transcription first.

## Accepted direction

- Hermes supplies the Telegram adapter, agent, tools, and built-in memory.
- Nocheh supplies durable capture, importing, original-data storage, scoped search,
  export/replay, and optional deterministic secret masking.
- PostgreSQL and a file store hold originals. Derived text and guarded caches do
  not overwrite them. Hermes keeps its native runtime state.
- ChatGPT subscription authentication powers production; no local models or paid
  model-provider API keys. Subscription transcription must pass live checks.
- Group replies use group-local memory; the owner's DM can search the archive.
- Honcho is an isolated optional experiment with a $5 maximum API budget.

See [the phased plan and flow diagram](docs/rebuild-plan.md),
[actual progress](TASK.md), and [the decision](docs/adr/0018-hermes-owned-archive-subscription-rebuild.md).

The previous bootstrap scripts and app commands still belong to the legacy code.
Replacement startup instructions will ship with Phase 2 after the feasibility gate.
