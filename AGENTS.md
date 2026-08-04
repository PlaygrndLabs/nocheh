# AGENTS.md

## Mission

Nocheh is a personal AI brain: it reads conversations, builds structured
long-term memory and a knowledge graph, and helps its owner remember, decide,
communicate, set goals, generate ideas, and improve routines.

Telegram is an adapter. Memory and reasoning are the product.

Operating domains: startups and partners, freelance clients and deliverables,
coaching and personal growth, projects and tasks, English learning, X/Twitter
growth, asset tracking, crypto decision support, and advice grounded in the
owner's memory, goals, routines, and accepted rules.

## Non-Negotiable Rules

1. **No raw chat as long-term memory.** Store structured records with source
   reference, confidence, and timestamp. Raw messages are temporary working data.
   Media bytes are never persisted: they are fetched, turned into text, and dropped.
2. **Redact before anything else.** Passwords, API keys, tokens, private keys,
   seed phrases, and connection strings must be redacted before buffering,
   analysis, persistence, logs, context building, or external sync. Text derived
   from media (descriptions, transcripts) is redacted with the same gate.
   The one placed exception: raw image and audio bytes reach the perception
   provider unredacted, because a JPEG cannot be pattern-scanned. Whichever
   provider fills the image and audio roles is trusted accordingly (ADR-0010).
3. **Human approval for external actions.** External effects stay `pending`.
   Nocheh may draft and suggest; it must not impersonate the owner or act on its own.
4. **Suggestions are not facts** until the owner accepts or converts them.
5. **No auto-trading.** Crypto support is decision support only.
6. **Cost is a feature.** Batch windows, bounded context, capped retrieval,
   per-window media caps, a media understanding cache, and dry-run mode when no
   provider is configured.
7. **Providers stay behind ports.** Transport in the adapter; prompt, output
   contract, and domain mapping stay shared.
8. **A model may detect, but never rewrite.** The secret guard returns the literal
   substrings it found; masking happens locally and deterministically. A model
   asked to rewrite text will also alter wording, and an edit would be
   indistinguishable from a redaction.

## Architecture

```text
interfaces -> application -> domain
infrastructure -> application ports
```

- `src/domain` — entities, memory graph, suggestions, redaction policy, audit.
  No I/O, no framework types.
- `src/application` — use cases, services, ports, provider catalog.
- `src/infrastructure` — Telegram, SQLite, security, reasoning, metrics, Notion MCP.
- `src/interfaces` — HTTP router, JSON API, Telegram webhook, static handler.
- `src/dev-server.ts` — the only composition root.

Conventions: TypeScript ESM with `.js` import specifiers, `readonly` domain
types, no `any`, ports for clock/id/logger/metrics so the core stays portable
(`test/core-layer-portability.test.ts` enforces this). New public types are
re-exported from `src/index.ts`.

## Current State

Pipeline:

```text
Telegram webhook | mock | note | history import
  -> text or caption or attachments (media-only messages are kept)
  -> pattern redaction -> LiveMessageBufferService (batch or immediate)
  -> [flush] media fetch -> perception model -> description + transcript
  -> secret guard over ALL text (typed, described, transcribed), fail closed
  -> MemoryGraphAnalyzerPort (NVIDIA glm-5.2 | Anthropic | noop dry-run)
  -> validated AI contract -> memory records + graph nodes/edges + tasks
  -> pending suggestions
```

Model roles, configured and degrading independently (ADR-0010):

| Role | Provider env key | Unset behaviour |
| --- | --- | --- |
| `text_analysis` | `AI_PROVIDER` | Dry-run |
| `image_understanding` | `AI_IMAGE_PROVIDER` | Images recorded, not described |
| `audio_understanding` | `AI_AUDIO_PROVIDER` | Voice notes recorded, not transcribed |
| `secret_guard` | `AI_GUARD_PROVIDER` | Pattern rules only |

Credentials are per provider; model ids are per role.

Implemented:

- Memory records: `Task`, `Decision`, `Project`, `Deadline`, `Blocker`, `Summary`
- Graph: 17 node kinds, 20 relations, 16 expanded payload kinds, status lifecycle
  (`active`/`superseded`/`archived`/`deleted`), scopes, temporal validity
- Suggestions: strategic + action, `pending`/`accepted`/`rejected`/`archived`/`converted`
- `AssistantContextBuilder`: recent window + retrieved memory + bounded graph
  neighborhood + accepted rules + high-value pending suggestions, token-capped
- Image and voice ingestion: attachment variants, per-kind model routing, derived
  text cache keyed on `file_unique_id`, per-window caps, bytes never persisted
- Secret guard: model detects literals, masking is local; fail closed with
  quarantine after repeated failures; interval-driven flush sweep
- Analysis contract generated from the domain: the prompt renders every vocabulary
  from `as const` arrays, the mapping layer validates against the same arrays, and
  each rejected item lands in the audit record's `errorLogs` with a reason
- SQLite with encrypted payload columns, per-step audit records, token usage
- Password-gated dashboard (`/app`), configurable redaction policy

Gaps to respect when planning:

- Retrieval is lexical, not embedding-based.
- Suggestion approval exists in the API and domain, not in the UI.
- Nocheh never sends outbound messages.
- Telegram is the only live channel.
- Only image and audio are understood. Documents, video, and stickers are recorded
  but never sent to a model.
- Reactions bypass the secret detector; they carry synthetic text, not user content.
- Telegram Desktop history imports skip media: export entries reference local file
  paths, not `file_id`s.
- **The graph contract is generated but unverified against a live model.** Every node
  kind, relation, scope, payload kind and suggestion kind is rendered into
  `analysisSystemPrompt()` from `as const` arrays in the domain, and the mapping layer
  rejects anything outside them. Verified by tests only; no real window has been run
  since. First item in `TASK.md`.
- Analysis takes 189-240s per window against `z-ai/glm-5.2`, which is longer than a
  Telegram webhook should block. The flush still runs in the request path.
- The perception model reproduces credentials it is told to omit (verified on a
  photographed password), so the secret guard is load-bearing, not belt-and-braces.
- NVIDIA wire formats are verified: audio uses `audio_url`, **not** the OpenAI
  `input_audio` block, and OGG/Opus needs no transcoding. See ADR-0010.

## Memory Policy

Every record carries `id`, `type`, `source`, `timestamp`, `confidence`. Graph
nodes and edges carry source references, confidence, and validity windows — never
raw chat text. Encrypted payloads depend on a stable `LOCAL_ENCRYPTION_SECRET`.

## Working Agreements

- Read the code before the docs; docs describe intent, code is the truth.
- Extend the domain before the UI. A feature that cannot be audited is not done.
- Add tests next to behavior: `npm test` (backend), `npm run test:web` (frontend).
- Record real decisions as a new ADR in `docs/adr/`. Do not rewrite accepted ADRs.
- Keep docs short and scannable. Delete stale sections instead of appending.

## Graphify (Dev Tooling Only)

Graphify builds a queryable graph of *this codebase*. It is not part of the
runtime and is not Nocheh's memory engine.

```text
Graphify            = dev/codebase graph
Nocheh memory graph = product/user/life graph
```

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"`
first.

For codebase questions, when `graphify-out/graph.json` exists:

```bash
graphify query "How does incoming message processing work?" --budget 1200
graphify path "<A>" "<B>"
graphify explain "<concept>"
npm run graphify:update        # after code changes, AST-only, no API cost
```

These return a scoped subgraph, far smaller than `graphify-out/GRAPH_REPORT.md`
or raw grep. Use `graphify-out/wiki/index.md` for broad navigation and
`GRAPH_REPORT.md` only for architecture review. Open `graphify-out/graph.html`
for interactive exploration.

Dirty `graphify-out/` files are expected and are not a reason to skip Graphify.
Skip only when the task is about stale graph output, or the user says not to.

Install (Python tooling, never a Node dependency; PyPI package `graphifyy`, CLI
`graphify`):

```bash
uv tool install graphifyy      # or: pipx install graphifyy
```

`.graphifyignore` excludes docs and markup so extraction works without an LLM
key. Rebuild from scratch by deleting `graphify-out/` and running
`npm run graphify:extract && npm run graphify:report`.
