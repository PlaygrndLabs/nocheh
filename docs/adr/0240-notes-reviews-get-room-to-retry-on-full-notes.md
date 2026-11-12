# ADR-0240: Notes reviews get room to retry on full notes

<status>
Accepted on 2026-11-12 as a bug fix: memory-notes reviews on nearly full notes
were cut off before their answer when they needed more than one note write.
Those that had changed no note were recorded `failed` and ran again; those that
had were left uncertain. Extends
[ADR-0239](0239-notes-reviews-make-room-in-full-notes.md); keeps
[ADR-0183](0183-failed-native-review-without-effect-runs-again.md) and
[ADR-0199](0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md).
</status>

<context>
- Nocheh gives Hermes's background review an input budget (`max_input_tokens`)
  and counts every prompt token of every call against it, cached or not
  (`services/hermes/native_memory.py`, since ADR-0199). Hermes checks it before
  each call and stops the review once it is used up. A review that stops right
  after a tool result has no answer: Hermes records `pending_tool_result`, and
  Nocheh records `empty_answer`.
- The budget was 24,000 tokens. A review's prompt is about 10,000 tokens a call,
  so a review got three calls.
- On nearly full notes a review sends batches that remove or patch entries and
  add the note. A batch is all or nothing: one operation that fails (a `patch`
  whose text matches no note, a missing field, still over the limit) refuses it
  whole. One refused batch, its retry and the answer just fit in three calls; a
  review whose third call was another write (a second refused batch, or a
  further write after one was applied) stopped before its answer.
- In a replay of 21 stored review inputs on nearly full notes (2,172 of 2,200
  characters), half or more of the note batches were refused on every route (8
  of 12 on the route before ADR-0199, 5 of 10 on the live route), mostly for a
  missing field. 1 of 21 reviews on the live route was cut off, 3 of 21 on the
  route before ADR-0199.
- A cut-off review that changed no note is recorded `failed` and runs again,
  up to four attempts (ADR-0183); one that already changed a note stays
  uncertain and is never repeated.
</context>

<decision>
- The review's input budget is 48,000 tokens, counted as before: room on full
  notes for more than one write and the answer.
</decision>

<consequences>
- In the same replay with 48,000, no review was cut off, the same reviews
  changed the notes as at 24,000 (21 of 21 sources), and the cost was not higher
  ($0.35 against $0.38 for 21 reviews). Calls past the third are mostly prompt
  cache reads.
- The budget doubles. The call that crosses it still completes, so at about
  10,000 tokens a call a review gets five calls instead of three, up to about
  50,000 prompt tokens instead of 30,000. Hermes's own 16-iteration limit and the review process's
  220-second limit (`services/hermes/review_worker.py`) stay; no replay run
  reached the latter.
- Checks: a real review in its own process, against a scripted local model
  server that reports 9,600 prompt tokens a call, whose lone add and first batch
  are refused, saves the note on the third call and answers on the fourth
  ([check](../../services/hermes/test_native_memory.py)).
</consequences>
