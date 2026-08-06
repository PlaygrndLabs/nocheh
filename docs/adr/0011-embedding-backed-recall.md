# ADR-0011: Embedding-Backed Associative Recall

## Status

Accepted

## Context

Nocheh could write memory but not recall it. Retrieval was
`SemanticMemoryRetrievalService`: F1 of token-set overlap, multiplied by the record's
confidence. Two problems made it unfit for the product's stated purpose — telling the
owner the thing they forgot.

**Word overlap cannot surface what you did not mention.** A memory only ranks if it
repeats the query's words. The memory worth recalling is the one phrased differently,
written months earlier, about a subject the current message only implies. That is not a
tuning gap; F1 over token sets is structurally incapable of it.

**The tokenizer discarded most of the owner's text.** `split(/[^a-z0-9]+/)` after
lowercasing keeps ASCII alphanumerics only, so Cyrillic, accented Latin, and CJK
tokenise to nothing and score zero against everything.

Three constraints shaped the design:

- Every searchable field of a `MemoryRecord` lives inside an AES-GCM payload with a
  random IV per call. Identical plaintext encrypts differently every time, so `LIKE`,
  FTS5, and any deterministic blind index are all unavailable. Retrieval already had to
  load and score in process; that is forced by the encryption model, not laziness.
- One runtime dependency (`better-sqlite3`), a darwin dev machine, and a linux
  deployment. Adding a native, platform-matrixed binary is a real cost.
- Rule 6: cost is a feature. Rule 2: derived content is redacted and encrypted like
  everything else.

## Decision

**Add an `embedding` model role and blend vector similarity with word overlap.**

- `EmbeddingPort` carries an explicit `query` / `document` kind. Retrieval embedding
  models are asymmetric — NVIDIA's nv-embedqa family requires `input_type` and Gemini
  takes a `taskType` — and mixing the two degrades recall silently. The distinction
  belongs in the port, not in each adapter's assumptions.
- Vectors are normalised on write, so similarity is a dot product with no division per
  query.
- Scores are a **weighted average**, not a sum with a ceiling: `(similarity + 0.25 ×
  lexical) / 1.25`. Word overlap stays as a bonus because exact tokens are what
  embeddings blur — a project slug or a person's name should promote a record without
  being able to outrank a genuine semantic match alone. A ceiling was tried first and
  rejected: clamping loses ordering exactly where similarity is high, so two records at
  the top of the range become indistinguishable and the tie falls through to timestamp.
- Raw cosine is **rescaled from a floor of 0.3**. Cosine has a high floor — two
  arbitrary sentences still score 0.2-0.4 — so a raw similarity is not comparable to a
  word-overlap score, and thresholds tuned for one are meaningless for the other.
  Rescaling makes 0 mean "no better than unrelated" and keeps the existing
  `minimumScore` values working.
- **Write-through indexing is a repository decorator**, not another use-case argument.
  Indexing is a consequence of saving a record; the use case already takes fourteen
  positional dependencies and needs no knowledge of embeddings. Removing the role
  removes the wrapper.
- **Backfill is explicit** (`POST /api/memory/reindex`). It is one paid model call per
  record, so enabling the role must not quietly spend money at boot. Startup reports the
  pending count instead.

**Store vectors in SQLite as encrypted base64 float32, and score in TypeScript.**

Rejected `sqlite-vec`: a `vec0` virtual table needs vectors readable by the query
planner, and an encrypted blob is as opaque to the extension as it is to `LIKE`. The
extension would add a native platform-matrixed dependency and buy nothing. Float32 over
JSON because a 1024-dimension vector is ~5.5 KB against ~20 KB, and float32 is the
precision embedding APIs serve. Vectors are encrypted because an embedding can be
partially inverted back towards its text, which makes it derived content under rule 2.

## Consequences

- Recall finds semantically related memory with no shared vocabulary, in any script.
- Degrades in three stages rather than failing: no embedding role means pure word
  overlap on the old scale; a failed query embedding logs and falls back the same way; a
  record with no vector yet still competes, scored as similarity 0 so a backfill backlog
  cannot dominate recall.
- Vectors from a different model are ignored, not compared, and the mismatch is logged.
  Changing embedding models requires a reindex.
- Retrieval still loads the corpus per query, now with a decrypted-vector cache
  invalidated on write. Unchanged asymptotics, one fewer full decrypt per query.
- **The wire formats are unverified against live APIs.** ADR-0010 records that NVIDIA's
  audio format deviated from OpenAI's; `input_type` and `batchEmbedContents` are written
  from documentation and covered by adapter tests only.
- The similarity floor and lexical weight are guesses until real similarity
  distributions are measured. Both are constructor options.
- Nothing reads retrieval yet. `AssistantContextBuilder` is still unwired; that is the
  next phase.
