# ADR-0012: Wiring Recall Into Analysis

## Status

Accepted

## Context

ADR-0011 built associative recall and ended with the honest admission that nothing read
it: embeddings were written on every memory save and never queried outside a test. The
`contextText` field on `ConversationAnalysisInput` had existed since ADR-0004 and was
never populated, so `AssistantContextBuilder` was dead code with a passing test.

That left the brain analysing each window as if it had never seen the owner before. It
could not resolve "the new client" against the client it already knew, could not reuse an
existing node id, and had no way to notice it was about to record a decision it recorded
last month.

Four things had to be decided.

**Where the context is built.** The buffer service already resolves settings and could
build the context before calling downstream — but the authoritative secret guard runs
*inside* the use case, and a recall query is sent to an embedding provider. Building it in
the buffer service would ship pre-guard text to an external API.

**What the context costs.** Recall now runs on every analysed window, not once per
backfill. `AssistantContext.text` renders the current messages, and the analyzer already
sends the window as a structured `messages` array, so grounding with `text` would pay for
every message twice.

**Where the graph expansion starts.** `AssistantContextBuilder.build` took
`graphCenterNodeIds` from its caller, and the pipeline has none: for a fresh window, no
node exists yet for its messages.

**Whether the model knows what it is being given.** The analysis contract is generated
from the domain vocabularies, and nothing in it mentioned `groundingContext`.

## Decision

**Build the context inside the use case, after the guard, before analysis.** Recall is an
external call and sits behind the same gate the analyzer does. `context_build` is a new
audit step between `redaction` and `analysis`.

**Pass the resolved `GroupAssistantSettings` down through `executeWindow`** rather than
letting the use case look them up again. The caller resolves them from stored rows *plus*
environment defaults; a second lookup downstream would see only the stored half, so
`MAX_RETRIEVED_MEMORIES` would be silently ignored for exactly the feature it bounds.

**Ground with `groundingText`, not `text`.** `AssistantContext` now carries both: `text`
for callers that want one self-contained blob, `groundingText` for callers that send the
window themselves. Both are independently capped at `maxAiContextTokens`.

**Seed graph centers from recalled memory when the caller gives none.** This is the
associative step, and it needs no new port method: recall finds a memory by meaning, the
memory names its source message, and `findNodesBySourceMessageId` names the nodes that
message created. One hop from there reaches knowledge sharing no words with the query.
Current messages are seeded too, so a note correcting an earlier message lands on the
knowledge that message produced. Capped at 16 source lookups, and only `active` nodes are
used as starting points. An explicitly empty list is respected, not re-seeded.

**Tell the contract what `groundingContext` is, and forbid extracting from it.** Told
nothing, a model reads it as more chatter and extracts it again — so grounding meant to
prevent duplicates would create them. The line costs ~62 input tokens on every call and is
pinned by a test.

**Count embedding tokens with a `MeteredEmbedding` decorator.** Recall spends tokens on
every window, which under rule 6 cannot be invisible. A decorator over `EmbeddingPort`
rather than a metrics argument on each caller: read path, write-through indexing and
backfill are then all counted by construction, and a caller added later cannot forget.

**A recall failure is not fatal.** Unlike the secret guard, whose failure is the one thing
worth stopping for, a failed context build is audited as a failed step, logged, and
stepped over. A window analysed without memory is worse; a window not analysed is lost.

## Consequences

- Verified end to end through the real composition root against fake NVIDIA endpoints:
  window 1 writes a `Decision` (embedded as `passage`) and a node; window 2 embeds its
  text as `query`, recalls the decision, seeds the graph center from its source message,
  and both reach `groundingContext`. The window text appears once, not twice.
- Every analysed window now costs one extra embedding call. Its tokens appear in
  `/api/metrics`, and the measured overhead of the grounding itself is in the
  `context_build` audit step's `approxTokens`.
- `memoryRecordText` is now defined as `type + memoryRecordSummary`, because the render
  prefixed the type onto a string that already began with it. The composition is a storage
  format — every stored vector was computed from that exact string — so the split is
  pinned by a test and produces byte-identical output.
- `ConversationWindowProcessorPort.executeWindow` takes an optional second argument. The
  immediate-mode path still calls `execute`, so it grounds with domain defaults rather
  than environment ones; immediate mode is testing-only.
- Reactions are still analysed without grounding. They carry synthetic text
  (`"(reaction update on an earlier message)"`), which is worth no embedding call.
- The similarity floor and lexical weight are still unmeasured, and both wire formats are
  still unverified against a live API. Wiring the read path did not change that; it did
  make it matter on every window instead of never.
