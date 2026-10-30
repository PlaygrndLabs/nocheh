# Model providers

Nocheh runs no provider proxy and no subscription login. Every model call goes
to a provider chosen in Settings › Models
([ADR-0141](adr/0141-per-part-model-providers.md),
[ADR-0142](adr/0142-external-providers-only.md)).

## Providers

- **OpenAI**: `https://api.openai.com/v1` with `OPENAI_API_KEY`.
- **Anthropic**: `https://api.anthropic.com/v1` with `ANTHROPIC_API_KEY`.
- **Custom**: any OpenAI-compatible HTTPS provider, such as a hosted
  gateway. It needs a short id, a name, its address and its API key. Custom
  providers are saved in `NOCHEH_PROVIDERS`; their keys in
  `NOCHEH_PROVIDER_KEYS`. Addresses must be `https://` without a password or
  query. `/v1` is optional. When an address has no API version in its path, such
  as `https://gateway.example.com`, and no model list there, the connection
  check in Settings › Models tries it with `/v1` and saves the address that
  answers. An address that answers as typed, or that has a version such as `/v1`
  or `/v1beta/openai`, is saved as typed. Saved addresses are used as saved.

Keys are saved in the installation `.env` and never returned to the browser.

## Providers for each part

One default provider and model (`NOCHEH_PROVIDER`, `NOCHEH_MODEL`) serve
replies (Hermes), memory (Honcho reasoning) and the secret check unless a part
names its own provider or model. Apply recreates the services whose routes
changed: Hermes and the security broker for replies and the secret check,
Honcho and its egress meter for memory and embeddings.

Memory search (embeddings) names its own provider (`NOCHEH_EMBEDDING_PROVIDER`,
`openai` by default) and keeps its capped budget: an initial $5 pilot, then $5
per month.

## Nothing configured

A fresh installation has no provider. Every service still starts. A part
without a provider is unconfigured: its model calls fail with
`provider_not_configured`, replies and memory work wait, and they resume after
a provider is saved and applied. Settings › Models and System show what is
missing.

## Voice notes

Voice notes, audio files and round videos, live or imported, are transcribed by
Hermes's own transcriber with the provider and model under Voice notes in
Settings › Models: OpenAI with its key and `gpt-transcribe` by default, or a
gateway that serves the same models. The transcript is checked for secrets like
typed text, and the original audio is kept. A reply waits for the transcript; a
busy provider is tried again, and a recording that cannot be transcribed records
why and does not hold the reply. Without a key, a voice note records "Voice note
archived; transcription is not available." and is transcribed once a key is
added. Usage shows each transcription's audio length and cost
([ADR-0193](adr/0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md)).

## Images

Photos and image files, live or imported, are read once by Hermes's own vision
tool with the Images part of Settings › Models, which uses the main model
unless another is chosen; it needs a model that sees images. The reading is the
image's text and a short description, from the "Reading images" instruction in
Settings › Assistant. It is checked for secrets like typed text, and the
original image is kept. A reply waits for it; a busy provider is tried again,
and an image that cannot be read records why. Stickers, animations and video
are not read. Usage shows each reading's tokens and cost
([ADR-0194](adr/0194-images-are-read-by-the-runtime-vision-tool.md)).
