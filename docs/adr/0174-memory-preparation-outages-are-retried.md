# ADR-0174: Honcho retries a memory preparation outage

<status>
Accepted on 2026-10-26 as a fix for a learning loss found by the synthetic
end-to-end tester.
</status>

<context>
Before Honcho's memory requests leave the installation, the provider gateway
asks the archive to prepare them: secrets are guarded and only content the
memory may see is kept. When that preparation failed for any reason, such as
the archive being busy or restarting, the secret check timing out, or the
guard epoch moving on during the request, the gateway refused the request
with HTTP 403. Honcho treats a 403 as the provider rejecting the request
itself, so it stops retrying and marks the learning task failed. In one
synthetic run, three ordinary messages were never learned this way.
</context>

<decision>
- An outage while preparing a request, meaning no answer, a timeout, an
  archive error 500 or above, or the archive reporting that the guard epoch or
  a prepared text changed during the request (`audience_context_changed`,
  `runtime_context_conflict`), is answered with HTTP 503 and
  `Retry-After: 15`, with the message `memory_preparation_unavailable`.
  Honcho retries a 503.
- Every other archive answer is a refusal and stays HTTP 403, now with the
  message `memory_preparation_refused`, for example content the memory may not
  see, a retired memory workspace, or an invalid prepared answer.
- Neither answer reserves budget or reaches the provider.
</decision>

<consequences>
- A brief preparation outage delays learning instead of losing it.
- Honcho still gives up on a real refusal at once, so it never spends retries
  on content it may not receive.
- An outage longer than Honcho's own retries still ends the task as failed,
  which the owner can run again from Memory › Long-term › Re-run (Retry failed
  learning).
</consequences>
