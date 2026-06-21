# Model Selection: Cost vs Reasoning

Date: 2026-06-21

## Decision State

No paid AI provider is selected yet.

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

### Claude Haiku / Sonnet via Bedrock or Anthropic

Strong quality candidate when advice quality matters more than minimum cost.

- Haiku is cheaper but may be less reliable for complex strategic reasoning.
- Sonnet is a stronger default-quality candidate, but output cost is much
  higher than Gemini Flash or DeepSeek.
- Bedrock can be attractive if AWS data/governance is preferred, but model
  choice still needs evaluation.

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
- Mak explicitly approves the provider/model.

## Sources Checked

- Anthropic Claude pricing: `https://platform.claude.com/docs/en/about-claude/pricing`
- Google Gemini API pricing: `https://ai.google.dev/gemini-api/docs/pricing`
- DeepSeek API pricing: `https://api-docs.deepseek.com/quick_start/pricing`
- Reasoning cost caution: `https://arxiv.org/abs/2603.23971`
