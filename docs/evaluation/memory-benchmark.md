# Memory Backend Evidence Gate

Phase 0 compares memory behaviour; it does not alter production memory. The harness uses one
provider-neutral contract for Nocheh and Honcho and keeps retrieval scoring separate from the
answer model.

## Privacy Boundary

- Put private benchmark files below `data/memory-benchmark/`; `data/` is ignored by Git.
- Export only text that has already passed pattern redaction, media understanding, and the
  final secret guard. Never export pre-guard text or media bytes.
- The runner rechecks the local pattern gate before a backend receives messages. It reports
  only unsafe message ids, never the detected literal.
- A scored report contains ids, numeric measurements, configuration hashes, and pass/fail
  gates. It never contains message text, question prompts, expected facts, context, or answers.

## Build The Pack

Keep the raw Telegram export outside the repository. Prepare a guarded text-only corpus with
the configured secret-guard provider (or an explicit temporary model id):

```bash
npm run benchmark:memory -- prepare-telegram \
  /absolute/path/to/result.json \
  data/memory-benchmark/private-v1 \
  nvidia/nemotron-3.5-lightning-30b-a3b
```

The command ignores every referenced media file, applies deterministic patterns before the
provider call, checks Persian password and recovery-phrase canaries, retries bounded batches,
and writes nothing until every batch validates. It records only guarded `corpus.jsonl` plus
secret-free preparation metadata. Run `probe-guard <model-id>` to test a replacement model
without sending private corpus text.

Copy `memory-benchmark-manifest.template.json` into the ignored private directory. Replace
every placeholder and choose the cost and quality thresholds before the first run. Then add:

- `corpus.jsonl`: one `MemoryBenchmarkMessage` per line in strict chronological order;
- `questions.json`: 60–100 private `MemoryBenchmarkQuestion` objects;
- one captured-run JSON per backend, produced by the backend adapter.

Generate deterministic scale corpora without personal data:

```bash
npm run benchmark:memory -- generate-scale 1000
npm run benchmark:memory -- generate-scale 10000
npm run benchmark:memory -- generate-scale 100000
```

Each size has 80 fixed questions covering factual recall, Persian, temporal corrections,
contradictions, multi-hop facts, deadlines, preferences, and long-range patterns. The extra
messages at larger sizes create storage/index pressure without increasing the grading set.

After copying the generated salted corpus hash and exact dates into the manifest, freeze and
verify the private pack:

```bash
npm run benchmark:memory -- validate \
  data/memory-benchmark/private-v1/manifest.json \
  data/memory-benchmark/private-v1/corpus.jsonl \
  data/memory-benchmark/private-v1/questions.json
```

The command prints the exact manifest SHA-256. Record that digest with both backend runs.
Changing the manifest after either run makes the comparison invalid.

Score a captured run into a commit-safe report:

```bash
npm run benchmark:memory -- score \
  data/memory-benchmark/private-v1/manifest.json \
  data/memory-benchmark/private-v1/corpus.jsonl \
  data/memory-benchmark/private-v1/questions.json \
  data/memory-benchmark/private-v1/nocheh-run.json \
  docs/evaluation/results/nocheh-report.json
```

Both live adapters now exist under `src/infrastructure/evaluation/`. The Nocheh adapter preserves
every original message id by processing chronological windows directly; using the old history
importer would collapse a chunk into one synthetic id and invalidate provenance scoring. Its
composition must use an inert task provider so a benchmark cannot sync tasks externally.

The Honcho adapter is pinned to `@honcho-ai/sdk` 2.4.0. Private corpora are loopback-only by
default, each source id is stored as message metadata, and scoring uses Honcho message search
under the shared token budget. It waits for the asynchronous reasoning queue to drain first.
Honcho's native dialectic `chat` is exposed separately and must not be mixed into the shared
retrieval score. Provider token/cost and database-size gates remain failed until the self-hosted
stack exposes those measurements; the report marks that telemetry as missing rather than zero.

Run the pinned self-hosted adapter after the pack validates and the fresh Honcho workspace is
running:

```bash
npm run benchmark:memory -- run-honcho \
  data/memory-benchmark/private-v1/manifest.json \
  data/memory-benchmark/private-v1/corpus.jsonl \
  data/memory-benchmark/private-v1/questions.json \
  docs/evaluation/results/honcho-report.json
```

The command refuses a non-loopback `baseUrl`. A remote host requires the explicit
`HONCHO_BENCHMARK_ALLOW_REMOTE=true` override and should never be used for private data without
separate approval of that destination.
