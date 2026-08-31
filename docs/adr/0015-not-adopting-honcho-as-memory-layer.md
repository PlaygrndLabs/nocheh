# ADR-0015: Not Adopting Honcho As The Memory Layer

## Status

Accepted

## Context

`docs/research/0004-honcho-vs-hermes.html` priced four options: (A) measure first,
(B) Honcho as an additive component behind a narrow port, (C) Honcho replaces the memory
layer, (D) migrate onto Hermes. The owner chose C, with an honest caveat attached: *"I
don't know how without knowledge graph is possible and need more research."*

That caveat was correct. Honcho's own source was then read at server version 3.1.0 rather
than its marketing, and the answer is not a matter of taste.

**The entire long-term memory record type is seven fields:**

```text
Conclusion: id, content (prose ≤65535), observer_id, observed_id,
            session_id, level (explicit|deductive|inductive|contradiction), created_at
```

No metadata. No confidence. No source reference. No validity window. No supersession. No
update endpoint — delete and recreate. No per-message delete. No export API. The dreaming
documentation claims conclusions carry "a confidence level"; no confidence field exists in
the API.

Against that, `MemoryEdge` carries `relation`, `fact`, `source`, `confidence`, `status`,
`valid_from`, `valid_until`. `Task` carries status, priority, `due_at`, and a Notion
`external_id`. Suggestions carry a five-state lifecycle plus `proposedNode` and
`proposedEdges`. Assets need six typed payloads and valuations. Crypto theses need a risk
relation, because rule 5 is a code-level guarantee rather than a prompt. **None of that is
hard to map onto a conclusion. None of it is expressible as one.**

Three findings are worse than mere absence:

- **The Dreamer deletes rather than supersedes.** Their own documentation: when a fact has
  changed over time it *"deletes the outdated conclusion and creates a new one."* The whole
  memory policy here is source reference plus confidence plus a `superseded` status. Honcho
  would destroy exactly the history the audit trail exists to preserve.
- **The real-time deriver emits only `explicit` facts.** `PromptRepresentation` has one
  field. Deductive and inductive conclusions — the coaching value, the actual reason to
  want this — come only from the Dreamer, which is flagged experimental, is a tool loop of
  up to 20 iterations run up to three times a day per representation, and is the single
  largest cost centre. Their reasoning docs show `deductive` in deriver output; that page
  is stale relative to the code.
- **There is no multilingual evidence of any kind.** The full repository and all three doc
  versions contain zero matches for `persian`, `farsi`, `multilingual`, or `i18n`. Every
  benchmark is English. The +17.3 LoCoMo points that make Honcho good come from
  Neuromancer, a Qwen3-8B fine-tune on ~10,000 curated **English** traces, with no public
  weights — hosted only. Self-hosting with an own model is a documented −6.9 points against
  a frontier model and −17.3 against the off-the-shelf base, worst on multi-hop.

The economics are also not what the research note assumed. The deriver does batch — one
structured-output call per token-bounded batch, ~20 calls/day at 500 English messages, not
500. But Persian tokenises two to four times worse per character, so those 1024-token
batches hold two to four times fewer messages; the summarizer is unbatched at ~33 calls a
day; and the Dreamer can reach ~120 calls a day per representation. That is on the order of
100–250 LLM calls a day against an endpoint measured at 13–17 tokens per second, with
`DERIVER_WORKERS=1` by default, and the Dreamer and Dialectic both **require** OpenAI tool
calling, which has never been verified on the endpoint in use.

Two operational traps for this codebase specifically: `EMBEDDING_VECTOR_DIMENSIONS` is
immutable for the life of a deployment with no in-place re-embedding path, so the embedding
model must be final before the first byte is ingested; and `seq_in_session` plus the
deriver's batch ordering follow insertion order rather than `created_at`, so importing
years of Telegram history out of order makes Honcho reason over it out of order.

## Decision

**Do not adopt Honcho now. Keep the graph, the analyzer, the records, the tasks, the
suggestions, and the audit trail.** Option C is rejected on evidence, not preference: it
would trade a schema the product depends on for prose that cannot hold a due date, a
portfolio, an approval state, or a corrected fact.

**Build the two things Honcho was wanted for, on owned rows.**

1. **Recall** moves to Postgres and pgvector (ADR-0014) with an OpenAI embedding model.
   Because the message log (ADR-0013) makes re-embedding a replay, the dimension trap that
   is permanent inside Honcho does not exist here.
2. **Consolidation** becomes a scheduled projection over the graph: contradiction
   detection, duplicate merging, supersession *with history preserved*, and confidence
   decay. This is the Dreamer's job done on typed rows, which means it can be audited,
   tested, and undone — none of which is true of a deleted conclusion.

**Honcho stays a candidate behind a named test, not an assumption.** Before any adapter is
written: a scratch self-hosted instance, ~300 real Farsi messages imported in
chronological order from the log, then read `POST /conclusions/list` and
`POST /conclusions/query` directly and answer three questions. Are conclusions written in
Farsi or silently translated to English? Are they self-contained? Does a Farsi query
retrieve them? If all three pass, it is wired as one more projection (`observe`) plus one
more grounding section (`recall`) behind a narrow `PeerRepresentationPort` that returns
strings — never `MemoryRecord`s — and the graph remains the record of fact while Honcho is
advisory context. If any fails, the spike is deleted and this ADR stands.

**Hermes remains a reference and never a dependency**, unchanged from the research note:
MIT-licensed, so the cron design, the channel-adapter shapes, document extraction, and the
draft/deliver split get read and reimplemented in TypeScript.

## Consequences

- The consolidation sweep is now owned work that nobody else is doing. Without it the graph
  accretes and contradictions accumulate; that risk moves from "Honcho's problem" to a
  scheduled phase with a deadline.
- The retrieval-quality bet is on OpenAI embeddings plus Persian text normalisation plus a
  floor measured from a real cosine distribution, rather than on a vendor's tuned stack.
  If that measurement shows recall is genuinely bad after tuning, the Honcho spike is the
  next move and the port shape is already specified above.
- AGPL-3.0 exposure is zero while nothing is deployed, and the defensible posture — an HTTP
  client of an unmodified instance in a separate process — is recorded here in case the
  spike ever passes.
- No prose-conclusion layer means no inductive or abductive inference for now. Coaching
  advice stays grounded in what windows said rather than what months of windows imply. That
  is a real capability gap, accepted knowingly, and it is the first thing the spike would
  buy back.
