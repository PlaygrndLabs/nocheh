# ADR-0017: Prove The Memory Backend Before Committing

## Status

Accepted. Amends the sequencing in ADR-0015. ADR-0015 remains the safe default until
this evidence gate produces a later ADR selecting an owned, Honcho-primary, or hybrid
memory backend.

## Context

ADR-0015 rejected Honcho as the memory layer after reading its source rather than trusting
its marketing. That found real incompatibilities with Nocheh's typed graph, provenance,
confidence, supersession, tasks, suggestions and audit trail. It did not prove the opposite
claim: that Nocheh's own memory will remain accurate, affordable and operable for years.

The current implementation bounds the prompt sent to a model: recent messages, retrieved
memories, graph depth, graph seed lookups and approximate tokens all have caps. Corpus growth
therefore does not directly become context-window growth. The work behind that prompt is not
yet bounded in the same way:

- `HybridMemoryRetrievalService` loads every record and every vector and scores them in the
  process.
- The similarity floor and lexical weight are guesses, and Persian lexical recall is zero.
- No long-horizon quality, load or cost benchmark exists.
- No consolidation process removes duplicates, finds contradictions or decays stale
  confidence.
- The graph contract and grounding behaviour have not been observed against enough live
  windows to establish reliability.

Honcho has a community, public evaluations and a purpose-built asynchronous memory pipeline.
Those are evidence of investment, not proof on this corpus. Its published results do not
cover mixed Persian and English Telegram history, media-derived text, the self-hosted model
configuration, Nocheh's typed operational records, or Nocheh's secret gate. Honcho is also a
moving system; a point-in-time source review cannot settle its future quality or operational
side effects.

The old plan made the most expensive possible assumption: implement owned recall and owned
consolidation first, then test Honcho in Phase 9 only if they looked poor. That creates sunk
cost before answering the question that determines the architecture.

## Decision

**Separate ownership of source data from selection of the memory engine.** The guarded,
ordered, append-only message log from ADR-0013 remains owned Postgres data in every outcome.
Credentials and media bytes never enter it. Memory engines are replayable projections over
that log, so a failed choice is replaceable rather than existential.

**Run the memory evidence gate before the Postgres and pipeline refactors.** Phase 0 builds
the evaluation pack and compares the current Nocheh implementation with a pinned,
self-hosted Honcho instance. Phase 1 adds the intended OpenAI provider to Nocheh and reruns
the Nocheh side so the final decision is not biased by the current slow endpoint. Phase 2
does not start until the results and the selected architecture are recorded in a follow-up
ADR.

**Use two corpora, for two different questions.**

1. A private quality corpus: guarded messages in strict chronological order, targeting at
   least 1,000 messages across at least three months when the export contains that much.
   Build 60–100 owner-graded questions covering factual recall, Persian, corrections over
   time, contradictions, multi-hop links, tasks and deadlines, preferences, and long-range
   coaching patterns. Personal corpus text and answers are never committed.
2. A deterministic synthetic scale corpus at 1k, 10k and 100k messages with seeded facts,
   corrections, duplicates and known answers. This measures storage, indexing, retrieval
   latency and context growth without exposing private data or paying to reason over 100k
   real messages. Derivation cost is measured on representative batches and projected from
   the observed call and token counts rather than guessed.

**Compare retrieval and end-to-end behaviour separately.** For retrieval, both systems
return context under the same token budget to the same answer model. A second native run may
use Honcho's own context or chat path, but its result is reported separately so memory
quality is not confused with a different answer model.

**Freeze the rubric before seeing results.** The benchmark manifest records versions,
models, configuration, token budgets, one salted aggregate corpus hash, network destinations
and numeric pass thresholds before a run. It measures:

- source-valid recall and grounded answer accuracy;
- temporal corrections, contradiction handling, duplicate rate and stale-fact rate;
- Persian retrieval, multi-hop retrieval and long-range behavioural inference;
- p50/p95/max context tokens, retrieval latency and background queue lag;
- ingest calls, input/output tokens, cost per 1,000 messages, cost per query and projected
  monthly maintenance cost;
- database and index growth, replay/re-index cost, backup/restore, deletion/export and
  recovery from unavailable models or workers.

The non-negotiable gates are independent of which system wins: unguarded text never crosses
the importer boundary; prompt context remains capped as corpus size grows; factual output is
traceable to source evidence; corrections do not silently erase audit history; and an
unavailable optional memory component degrades without losing ingestion or outbound safety.
The owner writes the acceptable monthly cost and quality thresholds into the manifest before
the first scored run so they cannot move after the result is known.

**The gate has three legitimate outcomes.**

1. **Owned memory.** Keep the typed graph and records, move recall to pgvector, and build the
   owned consolidation projection. ADR-0015 remains fully current.
2. **Honcho-primary semantic memory.** Honcho owns narrative recall and long-range
   inference. Nocheh still owns the guarded log, tasks, deadlines, approvals, audit records
   and any typed operational state Honcho cannot represent. A later ADR states whether the
   general graph is retained or retired; it is not deleted as part of the spike.
3. **Hybrid memory.** Nocheh remains the record of typed fact; Honcho supplies labelled
   narrative context. Each gets a fixed share of the context budget, contradictions are
   visible, and Honcho conclusions never become graph facts automatically.

The winning outcome is written as a new ADR with the measured table attached. A tie within
the predeclared quality margin is broken by lower operational complexity and total monthly
cost, not by implementation sunk cost.

## Consequences

- The Honcho spike moves from a conditional final phase to the first architectural gate.
- Phase 4 and Phase 8 become branches selected by evidence rather than promises to build an
  owned memory stack.
- The MVP answer path must use the selected memory contract, so it depends on the gate even
  though it can still ship before the importer rewrite when the selected backend permits it.
- Phase 0 now takes days and may produce throwaway evaluation code. That cost is deliberately
  paid before weeks of production refactoring.
- Community adoption is treated as useful prior evidence, not a substitute for a benchmark;
  bespoke domain fit is treated as useful control, not a substitute for a soak test.
- Benchmark fixtures and aggregate results may be committed. Private messages, derived
  personal conclusions and answer keys containing personal content may not be committed.
- A final long-horizon verification remains after implementation. The early bake-off chooses
  an architecture; it does not certify the production implementation built from it.
