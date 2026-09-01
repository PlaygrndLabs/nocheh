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

The next implementation slice adds the two live adapters. The Nocheh adapter must feed the
existing post-guard processing path and measure graph/task/suggestion persistence. The Honcho
adapter must pin its server version and jobs, map conversations to sessions, and receive only
the same guarded chronological messages. Neither adapter may become a production dependency
during Phase 0.
