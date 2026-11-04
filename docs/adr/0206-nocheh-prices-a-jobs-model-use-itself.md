# ADR-0206: Nocheh prices a job's model use itself

<status>
Accepted on 2026-11-04, after the owner's direction that the agent decides by itself
when work needs a job and Nocheh keeps the job's policy: its card, limits, access,
secret check, box, Stop and delivery. Extends
[ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md).
</status>

<context>
- A job stops at its cost limit, or takes one short step that writes the report
  there. The limit was not enforced with the default reply model.
- Each step's cost came from Hermes's own estimate of the turn (`turn_process.py`
  passed the usage's `cost_usd` on). Nocheh calls every provider through its own
  routes, and Hermes's pricing table is keyed by provider, so it has no price for
  the default reply model. Every step counted as free, and the cost limit never
  fired.
- A step that reports nothing must not count as free either: an answer without
  usage or a provider that omits it would otherwise lift the limit. Hermes counts
  every call of a turn, with or without usage, but adds tokens only from usage, so
  such a step arrives as calls with no tokens.
</context>

<decision>
- **Prices frozen on the card.** `start` asks the runtime once for the reply
  model's four rates in USD per million tokens: input, output, cache read and
  cache write, and its price per request, each unknown when no price is known.
  Claude on the Anthropic provider takes Nocheh's list prices, and the higher of
  its normal and long-prompt card for each bucket, with no price per request; any
  other model takes Hermes's pricing, asked with one-million-token rows and one row
  of a single call, since OpenRouter and OpenAI-compatible model lists can carry a
  price per request. The rates go into the job's row, its estimate and
  its fingerprint, so the card's estimate and the job's cost use the same prices.
  A price change during a job does not change its rates.
- **Tokens priced by Nocheh.** A step's receipt carries its token counts (the four
  buckets and the number of calls), not dollars. Storage checks them strictly
  (whole numbers from 0 below 10^12, no other fields) and prices them: the sum of
  each bucket times its frozen rate, over a million, plus the calls times the price
  per request, an unknown one counted as none. A cache bucket without its own rate
  takes the input rate. The job's cost only grows.
- **Unknown usage counted high.** A step receipt without valid counts is priced as
  if each of its iterations were a call of 100,000 input and 8,000 output tokens.
  So is one whose calls read no prompt token, since every model call reads a
  prompt: the runtime sends no counts for it, and storage prices such counts high
  too, by the calls when there are more of them than iterations.
- **Unknown price.** When the input or output rate is unknown, only the owner may
  approve the job, its card says "Cost can't be measured for this model: only the
  time limit applies", the cost limit is not checked and there is no byte
  backstop. The dashboard says the cost can't be measured.
- **The broker's byte backstop.** It does not rely on the step's own report. At
  `start`, `byte_budget = floor(cost_limit / cheapest non-zero rate per token of
  input, cache read and cache write × 12)`. For each model request of a turn bound
  to a job, the broker adds the guarded request body's bytes to the job's
  `model_bytes` in one statement, after the request is prepared and checked, and
  refuses it with a 409 `job_cost_limit` once the total passes the budget: Hermes
  takes a 409 as final, where a 401 or 403 would read as a rejected key, and the
  usage tracker counts such a run as a run Nocheh stopped, not as a model failure
  the owner is told of. Every prompt
  token costs at least the cheapest of those rates, and text is assumed to take
  under 12 bytes of JSON per token, so the backstop fires only once the limit has
  certainly been passed. The assumption is to be measured on a real installation.
  When the backstop is spent, the job fails with `job_cost_limit` without another
  step or a report step, since the broker would refuse their calls. The ordinary
  priced limit keeps its short report step.
- **The secret check is outside the limit.** The model-based secret check of new
  texts, such as the one a job's proposal takes, is counted under the guard's own
  usage, not per job. The card says the limit does not count the secret check.
- The installation rehearsal's scripted model has no price anywhere. There, and only
  with `NOCHEH_INSTALLATION_FIXTURE=1`, `NOCHEH_FIXTURE_REPLY_RATES` gives its rates,
  and `[[usage:N]]` sets the prompt tokens its answers report, so the limit can be
  tested end to end. Elsewhere the variable does nothing.
</decision>

<alternatives>
- **Hermes's own cost.** It has no price for Nocheh's provider routes, so jobs on
  the default model would stay free.
- **Parsing usage from the provider stream in the broker.** It would not depend on
  the step's report at all, but it reads every provider's stream format. Kept for
  later hardening; the byte backstop is the bound until then.
</alternatives>

<note date="2026-11-04">
Amended by [ADR-0207](0207-a-background-job-is-one-hermes-run.md): a job is one run,
priced from per-call hooks. Auxiliary calls such as compression and titles now count,
and each call without usage counts as an unknown call at 100,000 input and 8,000
output tokens plus the request price. Receipts no longer price missing counts by
iterations; a run that reports nothing is bound by the byte backstop, and a spent
backstop now ends the job with the short limit note instead of `job_cost_limit`.
</note>

<consequences>
- The cost limit holds with the default reply model, and a job on an unpriced model
  needs the owner's approval and is bound by its time only.
- Not counted yet: Hermes's auxiliary calls inside a step, such as context
  compression and session titles, which go to their own routes and are not in the
  step's token counts. They count once a job runs as one Hermes run with per-call
  hooks. The secret check is not counted per job either.
- The byte backstop is loose, by an estimate two to four times the limit, and
  counts requests that later fail. It is the only bound for what the step counts
  miss: a step whose process crashes or fails is never priced, and a step where
  only some calls came without usage is priced from the calls that had it, so it
  is under-counted. Per-call hooks in one Hermes run, or parsing usage from the
  provider stream in the broker, would count those calls. Jobs carry no images, which would weigh more per
  token.
- A step that fails and is tried again adds its tokens to Hermes's usage tracker
  but not to the job, as before; only finished steps are counted, once each.
</consequences>
