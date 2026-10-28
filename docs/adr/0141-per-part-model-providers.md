# ADR-0141: Each part of Nocheh chooses its provider and model

<status>
Accepted on 2026-10-13 by the owner's request. Supersedes the single
`NOCHEH_MODEL` reasoning route of the October 10 Claude provider change and
the subscription-only reasoning rule. Extends
[ADR-0035](0035-shared-cliproxy-provider-and-monitoring.md) and
[ADR-0034](0034-explicit-embedding-environment.md).
</status>

<context>
The owner wants Nocheh's logic off their own machine and chose to use their hosted
provider gateway instead of Nocheh's own provider
login. They asked for a provider feature in Settings: existing providers such
as GPT and Anthropic, or a custom provider added by URL and API key; one key is
enough, but each part may use its own provider and model, for example GPT for
Honcho and Anthropic for Hermes.

Before this, Hermes, the secret detector, Honcho reasoning and the Honcho
egress meter all used one model through the built-in CLIProxyAPI, with that
address fixed in several allowlists, and embeddings were fixed to OpenAI.
</context>

<decision>

- A provider is the built-in login (`builtin`, Nocheh's CLIProxyAPI), the
  OpenAI or Anthropic preset with a fixed HTTPS address and its own key
  setting, or a custom provider with an id, a name and an HTTPS address. Every
  provider speaks the OpenAI-compatible API. Custom keys live in one secret
  setting keyed by provider id; the browser sends only newly typed keys, and
  keys of removed providers are dropped.
- The parts are replies (Hermes), memory (Honcho reasoning), the secret check
  (literal detection) and memory search (embeddings). `NOCHEH_PROVIDER` and
  `NOCHEH_MODEL` are the default; each reasoning part may name its own
  provider and model. Embeddings always name their own provider and cannot use
  the built-in login or Anthropic, which serve no embeddings.
- `tools/operations/provider/routes.py` is the only resolver. Compose receives
  the resolved reply and secret-check address, model and key; Honcho's
  generated `meter.env` receives the memory and embedding addresses, model and
  key. Validation refuses an unknown provider, a non-HTTPS address, a part
  whose provider has no key, and another provider under the native route.
- The trust boundaries keep their shape. The security broker forwards replies
  only to the built-in address or the one configured HTTPS reply address.
  Hermes accepts a transport only for the built-in, broker or configured
  addresses. The detector exemption stays bound to the exact detector
  address. The Honcho meter accepts its built-in address or an HTTPS address
  and keeps its budgets.
- The detector version includes the secret-check model, so changing it
  re-derives guarded copies like any detector change.

</decision>

<consequences>

- The owner can point every part at the gateway with one key, or split parts
  between providers, from Settings › Models; Apply recreates only the services
  whose routes changed, and refreshes Honcho when its generated settings
  change.
- Voice transcription still uses the built-in ChatGPT login; the owner left
  voice out for now.
- Anthropic's OpenAI-compatible endpoint ignores some OpenAI fields such as
  `response_format`; Honcho's structured output through it is unproven.
- Live acceptance through a custom provider is pending.

</consequences>
