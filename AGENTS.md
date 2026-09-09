# Nocheh

## Mission and active architecture

Nocheh is a personal AI brain with Hermes as its first replaceable runtime. Telegram is an adapter;
owned source data, useful memory, and reasoning are the product.

The accepted implementation plan is [docs/rebuild-plan.md](docs/rebuild-plan.md).
[ADR-0018](docs/adr/0018-hermes-owned-archive-subscription-rebuild.md) supersedes
the previous implementation direction. Check `TASK.md` for actual phase status.
ADR-0027 and [docs/runtime-platform-plan.md](docs/runtime-platform-plan.md) make Nocheh the main product and Hermes a runtime adapter; implement its seven phases separately.
ADR-0019 makes local Docker Compose the current development and acceptance target;
VPS work is deferred. Do not mistake planned phases for completed behavior.

## Product rules

1. Preserve original messages, observed events, revisions, and retrievable file
   bytes in the owned archive. Store transcripts and other generated artifacts
   separately, with provenance. Never replace an original with a model output.
2. Guarding is `on` (default) or `off` under ADR-0033. Prepare durable guarded
   projections at ingestion; reuse them without repeated detection. The owner can
   inspect originals and edit guarded projections. Saved owner edits are final.
   On sends only current guarded data to agents and memory; required enforcement
   fails closed on every model attempt. Consult TASK.md for activation status.
3. A model detects literal secret substrings; local code validates and masks them.
   All other text remains exactly unchanged. Detection quality is measured, never
   described as a guarantee that every possible secret will be found.
4. Raw media may reach explicitly trusted perception/transcription providers.
   Derived text is prepared and versioned under the same guard policy as typed text.
5. Proactive conversation is permitted in selected Telegram groups. Other
   external effects require owner approval. No auto-trading. Group members may
   not approve actions or change administrative/provider/guard settings.
6. The owner's private assistant may connect all registered native memories and
   archived sources. Groups/topics use versioned isolated, approved (default), or
   explicitly selected filtered sharing (ADR-0028). Enforce audience access in
   tools, storage, notes, graphs and delivery. Inferences are not source facts.
   Imported-content learning requires explicit approval during import.
7. Reasoning uses ChatGPT subscription authentication; no local models or paid
   reasoning keys. ADR-0033 authorizes dedicated paid embeddings only: a $5 total
   pilot cap, then $5/month. Never use unrelated provider credentials. Automatic
   transcription remains a release requirement; missing live evidence is pending.
8. Reuse Hermes's Telegram adapter, agent, tools, profiles, and built-in memory.
   Keep custom integration thin; a minimal pinned upstream compatibility patch is
   allowed for durable capture and mandatory guard enforcement.
9. Nocheh owns one PostgreSQL archive and file store. Guarded projections and owner
   revisions are durable records in that database. Hermes owns its native runtime state.
   Preserve source identities and provenance for portable export and replay.

## Implementation agreements

- Preserve `codex/legacy-nocheh`; work on `codex/hermes-rebuild`. Old persisted data
  is disposable and requires no migration. Do not merge to `main` before release
  gates pass.
- Complete and verify each phase, commit it, report its hash, and continue
  automatically. Do not ask for repeated permission for authorized phase work.
- Phase 1 proves subscription chat, detection, transcription, refresh/failure
  handling locally. Phase 2 rechecks compatibility inside Compose. VPS validation
  is deferred by the owner (ADR-0019). If transcription fails, retain evidence and
  stop dependent release work. Missing credentials are pending checks, not passes.
- Continue independent work when possible; do not claim an unfinished phase is
  complete. The optional Honcho live comparison does not block production.
- TypeScript services, thin Python Hermes integration, Docker Compose for local
  and VPS operation. Pin tested upstream revisions. Keep credentials and runtime
  data out of commits and logs.
- Read code before docs. Add meaningful behavior tests, including failure paths.
  A phase is complete only when its documented acceptance criteria pass.
- Record new decisions in new ADRs; preserve accepted historical ADRs. Keep active
  documentation short and distinguish implementation from plans.

## Graphify (development tooling only)

Graphify is this repository's code graph, not Nocheh's product memory.
For codebase questions use the graph when `graphify-out/graph.json` exists:

```sh
graphify query "How does incoming message processing work?" --budget 1200
graphify path "<A>" "<B>"
graphify explain "<concept>"
npm run graphify:update
```

Dirty graph output is expected. Do not skip Graphify because of it. Rebuild after
code changes with the AST-only workflow; keep it out of runtime dependencies.
