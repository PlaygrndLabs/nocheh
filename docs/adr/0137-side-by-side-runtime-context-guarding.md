# ADR-0137: Runtime context for one audience is guarded side by side

<status>
Accepted on 2026-10-12. Extends [ADR-0127](0127-parallel-guard-checks.md) from
message preparation to guarded runtime context, including Honcho's provider
requests.
</status>

<context>
`PreparedContextRepository.prepare` guards text before it reaches a model:
Hermes runtime context and every Honcho provider request (reasoning and
embeddings). It held one in-process queue per audience and guard binding.
Honcho's provider requests all run as the installation's owner audience, so
every Honcho reasoning and embedding request, for recall and background
derivation alike, was guarded one at a time across the installation, each
waiting for the previous one's detector call. In the October 12 live checks a
group recall question spent 40 to 75 seconds in Honcho recall, with about ten
detector calls of 2 to 6 seconds each in that window, although recall asks
Honcho's connected peers side by side.
</context>

<decision>

- Preparations for one audience run side by side. Only identical fresh text is
  shared: the first request to need a text claims it, and a concurrent request
  for the same text waits for that result instead of detecting and publishing
  it again. A failed claim does not fail the waiting request; it guards the
  text itself.
- Durable guarded publications stay bounded at four at once, now across every
  preparation in the process, below the eight-connection store pools.
  After a failure nothing new starts, and started work drains before the
  failure is reported.
- Detector calls stay bounded by `NOCHEH_PARALLEL_GUARD_CHECKS` in Hermes.
- Cross-process races still converge on the immutable operation identities of
  the guarded copy and its detection checkpoint.

</decision>

<consequences>
- A Honcho recall's reasoning and embedding requests, and background Honcho
  derivation, no longer queue behind each other at the guard.
- Two concurrent requests whose texts overlap only partly may each detect
  their own fresh part; that costs extra detector calls but never leaves text
  unguarded.
</consequences>
