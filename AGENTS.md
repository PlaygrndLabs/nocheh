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
2. Guarding is optional: `off`, `on`, `auto` (default). Trust is an explicit
   destination policy, not a model-name heuristic. Trusted ChatGPT routes may
   receive originals. Required guarding fails closed on every model attempt,
   including history, tool results, auxiliary calls, and route changes.
3. A model detects literal secret substrings; local code validates and masks them.
   All other text remains exactly unchanged. Detection quality is measured, never
   described as a guarantee that every possible secret will be found.
4. Raw media may reach explicitly trusted perception/transcription providers.
   Derived text follows the same outgoing-request guard policy as typed text.
5. Proactive conversation is permitted in selected Telegram groups. Other
   external effects require owner approval. No auto-trading. Group members may
   not approve actions or change administrative/provider/guard settings.
6. Group replies use only that group's memory and source data. The owner's
   private DM may search across the archive. Enforce scope in tools and storage,
   not only prompts. Suggestions and inferred claims are not source facts.
7. Production uses ChatGPT subscription authentication: no paid model-provider
   API keys and no local models. Automatic transcription is a release requirement.
   The isolated Honcho experiment has a $5 maximum metered API budget and may use
   an explicitly supplied temporary key. Never use existing unrelated API keys.
8. Reuse Hermes's Telegram adapter, agent, tools, profiles, and built-in memory.
   Keep custom integration thin; a minimal pinned upstream compatibility patch is
   allowed for durable capture and mandatory guard enforcement.
9. Nocheh owns one PostgreSQL archive and file store. Optional guarded copies are
   versioned cache records in that database. Hermes owns its native runtime state.
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
