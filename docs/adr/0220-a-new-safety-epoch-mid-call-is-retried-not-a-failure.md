# ADR-0220: A new safety epoch mid-call is retried, not a failure

<status>
Accepted on 2026-11-09 after the owner's notice said a reply and a memory-notes
run failed because "the provider rejected the request", and memory said its
learning failed, all within one minute of the owner saving a memory. Extends
[ADR-0174](0174-memory-preparation-outages-are-retried.md) and
[ADR-0206](0206-nocheh-prices-a-jobs-model-use-itself.md).
</status>

<context>
Saving a memory moves the safety epoch on. Work that started in the old epoch
may not reach a model again: the broker cuts an answer still streaming, and the
secret check refuses the next call with `guard_context_changed`. Nocheh then runs
the reply, the notes review and the learning again in the new epoch.

Three things went wrong on that path:

- The secret check refuses inside the HTTP client, so the provider client
  reports the refusal as a lost connection ("Connection error."). Hermes then
  finds the secret check's HTTP 409 in the error's chain and names the call a
  malformed request (`format_error`). Nocheh's usage tracker took that as the
  provider's own rejection, and the owner was told the provider rejected the
  request. The same happened for any other refusal of the secret check.
- The broker's own refusals were kept only as Nocheh's error, without their
  code, so nothing said which refusal it was.
- When Honcho's learning request was being prepared as the epoch moved on, the
  archive answered `guard_context_changed` or `guard_transition_pending`.
  ADR-0174 meant an epoch change to be retried, but these codes were not on the
  gateway's retry list, so the gateway refused the batch with HTTP 403 and Honcho
  dropped it.
</context>

<decision>

- A run whose model call Nocheh refused because the safety epoch moved on is a
  stop of Nocheh's own, `context_changed`, like a job's cost limit: it counts as a
  run, not as a failure the owner is told of. It is known by the secret check's
  refusal of a model call in the run's process, or by the broker's refusal, with
  `guard_context_changed`, `guard_transition_pending`, `audience_context_changed`
  or `runtime_turn_changed`.
- Any other refusal of the secret check, when the run ended on the lost connection
  the client reports for it, and any other broker refusal, is Nocheh's own error
  with the refusal's code as its cause, such as
  `nocheh_error:detector_contract_rejected`. A turn that ended on Nocheh's own
  error before any model run keeps that error's code the same way. Only codes are
  kept, never the provider's message or any content.
- The provider gateway answers `guard_context_changed` and
  `guard_transition_pending` from memory preparation as an outage: HTTP 503 with
  `Retry-After: 15`, which Honcho retries.
</decision>

<consequences>
- Saving a memory during a reply no longer sends a problem notice; the reply
  runs again in the new epoch.
- A notice about Nocheh's own refusal says which refusal it was, such as
  "Nocheh’s own error (detector contract rejected)".
- An epoch change during learning delays the batch instead of losing it. An epoch
  publication that outlasts Honcho's own retries still ends the task as failed,
  which the owner can run again from Memory › Long-term › Re-run.
</consequences>
