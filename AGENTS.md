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
2. **Redact before anything else.** Passwords, API keys, tokens, private keys,
   seed phrases, and connection strings must be redacted before buffering,
   analysis, persistence, logs, context building, or external sync.
3. **Human approval for external actions.** External effects stay `pending`.
   Nocheh may draft and suggest; it must not impersonate the owner or act on its own.
4. **Suggestions are not facts** until the owner accepts or converts them.
5. **No auto-trading.** Crypto support is decision support only.
6. **Cost is a feature.** Batch windows, bounded context, capped retrieval, and
   dry-run mode when no provider is configured.
7. **Providers stay behind ports.** Transport in the adapter; prompt, output
   contract, and domain mapping stay shared.

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
  -> secret detection + redaction
  -> LiveMessageBufferService (batch or immediate)
  -> MemoryGraphAnalyzerPort (NVIDIA glm-5.2 | Anthropic | noop dry-run)
  -> validated AI contract -> memory records + graph nodes/edges + tasks
  -> pending suggestions
```

Implemented:

- Memory records: `Task`, `Decision`, `Project`, `Deadline`, `Blocker`, `Summary`
- Graph: 17 node kinds, 20 relations, 16 expanded payload kinds, status lifecycle
  (`active`/`superseded`/`archived`/`deleted`), scopes, temporal validity
- Suggestions: strategic + action, `pending`/`accepted`/`rejected`/`archived`/`converted`
- `AssistantContextBuilder`: recent window + retrieved memory + bounded graph
  neighborhood + accepted rules + high-value pending suggestions, token-capped
- SQLite with encrypted payload columns, per-step audit records, token usage
- Password-gated dashboard (`/app`), configurable redaction policy

Gaps to respect when planning:

- Retrieval is lexical, not embedding-based.
- Suggestion approval exists in the API and domain, not in the UI.
- Nocheh never sends outbound messages.
- Telegram is the only live channel.

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
