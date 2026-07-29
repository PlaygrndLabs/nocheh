# Model Selection: Cost vs Reasoning

Date: 2026-06-21

## Decision State

**Superseded on 2026-07-28: selected NVIDIA API Catalog with `z-ai/glm-5.2`
(GLM-5.2 by Z.ai).** See `docs/deploy.md` -> "Provider and Cost".

Reasons for the choice over the shortlist below:

- 1M-token input context, so a whole conversation window plus grounding context
  fits without aggressive trimming.
- Advertised structured output and function calling; the adapter requests
  `response_format: { type: "json_object" }` and still validates everything
  against the provider-neutral contract.
- OpenAI-compatible endpoint, so the adapter is thin and the same transport can
  be repointed at another gateway with `NVIDIA_BASE_URL`.
- Strong reasoning/agentic benchmark results relative to cost.

Open items from this research that still apply:

- Real cost per window and per month is still unmeasured; the shortlist below
  stays relevant if GLM-5.2 proves too expensive for noisy groups.
- The two-tier policy (cheap extraction tier plus a stronger reasoning tier) is
  still the intended cost-control mechanism.
- Provider config stays explicit: `AI_PROVIDER` is blank by default and a
  provider never activates just because credentials exist.

The original research state follows, kept for context.

### Original state (2026-06-21)

No paid AI provider is selected yet. The first preferred quality candidate is
Claude Sonnet through Anthropic direct API, not AWS Bedrock.

Nocheh should continue using the rule-based analyzer until a model is selected
through a small eval set and budget review. Provider config must stay explicit:
`AI_PROVIDER` is blank by default, and a provider should not activate just
because credentials exist.

## What Nocheh Needs From A Model

- Reliable structured JSON for memory nodes, edges, suggestions, and warnings.
- Good reasoning for goals, routines, priorities, weak signals, and business
  advice.
- Low enough output-token cost for frequent chat analysis.
- Strong safety behavior for crypto, external actions, impersonation, and raw
  secret handling.
- Large enough context for grouped chat batches, but no full-history prompts.
- Clear token usage reporting.

## Current Shortlist

### Gemini 2.5 Flash / Flash-Lite

Strong candidate for first cost-controlled experiments.

- Gemini 2.5 Flash is priced in the low-cost tier and includes thinking tokens
  in output pricing.
- Flash-Lite is cheaper and may be useful for high-volume simple extraction.
- Concern: cheap listed pricing can be misleading if thinking tokens grow.

Use for:

- First memory extraction eval.
- High-volume routine chat analysis.
- Cost baseline.

### DeepSeek V4 Flash / Pro

Strong cost candidate, especially for cheap reasoning experiments.

- DeepSeek V4 Flash is very cheap per input/output token and supports JSON
  output, tool calls, thinking/non-thinking modes, and 1M context.
- DeepSeek V4 Pro is still inexpensive compared with many frontier models.
- Concern: privacy/compliance, geopolitical/vendor risk, and potential behavior
  variance need review before personal/business data use.

Use for:

- Cost stress tests.
- Non-sensitive synthetic evals.
- Possible self-host/open-router comparison later.

### Claude Sonnet via Anthropic

First-priority quality candidate when advice quality matters more than minimum
cost.

- Sonnet is a stronger default-quality candidate, but output cost is much
  higher than Gemini Flash or DeepSeek.
- Direct Anthropic API is the preferred integration path for this project.
- Haiku can still be tested later as a cheaper Claude extraction baseline, but
  it is not the first target.

Use for:

- Strategic suggestion quality benchmark.
- Safety/refusal benchmark.
- High-value analysis mode, not every message.

## Avoid For Now

- Do not select OpenAI by default.
- Do not select a provider only because an adapter exists.
- Do not use a premium reasoning model for every incoming message.
- Do not compare only listed token prices; actual cost must include generated
  reasoning/thinking tokens.

## Eval Plan

Create a small local eval set with 40-60 sanitized examples:

- Startup partner decision.
- Freelance client delivery.
- English learning routine.
- X/Twitter content planning.
- Asset tracking.
- Crypto thesis and no-trade safety.
- Mixed group chat with noise.
- Secret/redaction edge cases.

Score each model on:

- JSON validity.
- Correct node/edge extraction.
- Suggestion usefulness.
- No raw chat text in durable memory.
- Correct safety boundary.
- Token usage and estimated request cost.
- Latency.

## Selection Policy

Use a two-tier model policy:

- Cheap extraction model for routine chat processing.
- Strong reasoning model only for deliberate review, coaching, planning, or
  high-value suggestion generation.

Do not enable a paid provider until:

- The eval harness exists.
- At least two low/mid-cost models have been tested.
- Monthly cost is estimated from expected message volume.
- The owner explicitly approves the provider/model.

## Sources Checked

- Anthropic Claude pricing: `https://platform.claude.com/docs/en/about-claude/pricing`
- Google Gemini API pricing: `https://ai.google.dev/gemini-api/docs/pricing`
- DeepSeek API pricing: `https://api-docs.deepseek.com/quick_start/pricing`
- Reasoning cost caution: `https://arxiv.org/abs/2603.23971`
