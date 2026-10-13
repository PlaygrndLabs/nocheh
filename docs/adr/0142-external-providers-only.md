# ADR-0142: Nocheh runs no provider proxy; every model call uses a Settings provider

<status>
Accepted on 2026-10-13 by the owner's request. Supersedes
[ADR-0035](0035-shared-cliproxy-provider-and-monitoring.md),
[ADR-0103](0103-relay-every-provider-oauth-login.md), the built-in provider of
[ADR-0141](0141-per-part-model-providers.md), and the subscription
transcription parts of
[ADR-0018](0018-hermes-owned-archive-subscription-rebuild.md) and
[ADR-0033](0033-guarded-projections-and-honcho-memory.md).
</status>

<context>
The owner chose a hosted provider gateway for model calls and asked: "remove
CPA and it admin panel from our services." CPA is the CLIProxyAPI service
(`cliproxy-api`) that held the subscription logins, and its admin panel is CPA
Manager Plus (`cliproxy-monitor`). The ChatGPT speech route (`chatgpt-speech`
with `codex-asr`) read CPA's ChatGPT login, and the owner had already asked to
leave voice out. The owner also wants usage tracked by Nocheh itself, not by
CPA.
</context>

<decision>

- Compose has no `cliproxy-api`, `cliproxy-monitor` or `chatgpt-speech`
  service, no provider OAuth callbacks, no provider login commands and no
  native ChatGPT login route.
- Providers are only those of Settings › Models: OpenAI and Anthropic by API
  key, and custom OpenAI-compatible HTTPS providers. A fresh installation has
  none. A part without a provider is unconfigured: every service still starts,
  its model calls fail with `provider_not_configured`, waiting work resumes
  after a provider is saved and applied, and the dashboard says what is
  missing.
- Voice notes keep their original audio and an extraction status saying
  transcription is not available; they never hold a reply.
- The installation and Telegram rehearsals use a deterministic `model-fixture`
  service as a custom provider. Only its exact address
  `http://model-fixture:8317/v1`, and only with `NOCHEH_INSTALLATION_FIXTURE=1`,
  is accepted without HTTPS.

</decision>

<consequences>

- After this change an installation answers nothing until the owner adds a
  provider; this is shown on Settings › Models and System.
- Real-model simulator runs that relayed to the operating installation's
  CLIProxyAPI are gone; a real-model run uses a provider from Settings instead.
- Usage across replies, memory, the secret check and embeddings is no longer
  visible in CPA Manager Plus and needs Nocheh's own tracker.
- Voice transcription returns only by a later owner decision.

</consequences>
