# Development Tooling

## Graphify

Graphify is optional developer tooling for building a queryable knowledge graph
of this codebase. It is not part of the Nocheh runtime and should not be used as
the user-memory engine.

Use it for:

- architecture discovery before large changes
- finding cross-file relationships
- generating a local codebase graph
- helping coding agents inspect the repo without repeatedly grepping files

Do not use it for:

- storing Mak's personal memory
- replacing Nocheh's `MemoryNode` / `MemoryEdge` graph model
- app runtime dependencies

## Install

Graphify's PyPI package is `graphifyy`, while the CLI command is `graphify`.
This machine is currently set up with:

```bash
python3 -m pip install --user graphifyy
```

The CLI is expected at:

```bash
/Users/owner/.local/bin/graphify
```

Preferred fresh install on another machine:

```bash
uv tool install graphifyy
```

Alternative:

```bash
pipx install graphifyy
```

Avoid adding Graphify as a Node dependency; it is Python-based dev tooling, not
an app runtime dependency.

## Project Setup

Project-scoped Codex integration has been installed:

```text
AGENTS.md
.codex/hooks.json
.codex/skills/graphify/
```

The Codex hook nudges future codebase questions toward Graphify queries when
`graphify-out/graph.json` exists.

The default `.graphifyignore` excludes docs and markdown/yaml/html/text files so
the local graph can be generated without an LLM API key. This gives a code/config
graph by default. To include docs semantically, remove or relax those ignores and
set a supported Graphify API key before extraction.

## Generate The Codebase Graph

From the repo root:

```bash
npm run graphify:extract
npm run graphify:report
```

This creates:

```text
graphify-out/
├── graph.html
├── GRAPH_REPORT.md
└── graph.json
```

`graphify-out/` is gitignored because it is generated output.

The current initial graph was generated with:

```bash
graphify extract . --no-cluster --out .
graphify cluster-only . --no-label
```

It scanned 123 code/config files and produced a graph with 825 nodes, 2098
edges, and 40 communities.

## Daily Use

Query the graph:

```bash
graphify query "How does incoming message processing work?" --budget 1200
```

After code changes:

```bash
npm run graphify:update
```

For broad architecture questions, inspect:

```text
graphify-out/GRAPH_REPORT.md
```

For interactive exploration, open:

```text
graphify-out/graph.html
```

To rebuild from scratch, delete `graphify-out/`, then run:

```bash
npm run graphify:extract
npm run graphify:report
```

## Boundary With Nocheh Memory

Keep this boundary clear:

```text
Graphify = dev/codebase graph
Nocheh memory graph = product/user/life graph
```

Graphify can help us build Nocheh faster, but Nocheh still owns its runtime
memory model, privacy rules, encrypted persistence, source references, approval
flow, and user knowledge graph.
