# ADR-0199: Anthropic replies use the Messages API for prompt caching

<status>
Accepted on 2026-11-01. The owner asked that Nocheh use Anthropic's prompt caching
("I want to make sure that we comply with this in Nocheh") after Anthropic reported a
low cache hit rate on the account's API key, and to merge only if replies stay the same
and the change is not less efficient. Extends
[ADR-0141](0141-per-part-model-providers.md) and
[ADR-0142](0142-external-providers-only.md).
</status>

<context>
- Every provider was reached through its OpenAI-compatible API, the Anthropic preset
  included. Anthropic's OpenAI-compatible API has no prompt caching; only its Messages
  API has it. A running installation recorded no cache reads or writes on any
  Anthropic call.
- Most Anthropic input went to Hermes turns: memory-notes reviews (about 9,500
  input tokens per call, several calls per review) and replies. Each call of a turn
  resends the same tools, system prompt and history.
- Hermes already speaks the Messages API (`anthropic_messages`) and places its own
  cache breakpoints there: the tools and system prompt, and the last two messages.
  The security broker allowed only the OpenAI-compatible chat route.
- The memory evidence was inserted ahead of all history on every call, so a change in
  it changed every message after the system prompt.
- Anthropic's OpenAI-compatible API ignores the reasoning effort setting, so replies ran
  with the model's own default thinking. The Messages API would apply the setting.
- Hermes stops a memory-notes review once its input reaches a budget, counting only
  uncached input on the Messages API.
- At the step limit Hermes asks for a summary on the Messages API without tools, though
  the request still holds the turn's tool calls, which Anthropic refuses.
- A profile remembered one session's prompt revision, so two sessions of one profile
  taking turns, such as a group's topics, cleared each other's stored prompt.
- The secret check, privacy filter, image reads and Hermes's one-shot helper calls
  (session search, titles, compression) have prompts too short or too unique to cache.
</context>

<decision>
- When replies use Anthropic (`https://api.anthropic.com/v1` in Settings › Models) and
  turns are isolated, Hermes turns and memory-notes reviews use Anthropic's Messages
  API through the broker's `/anthropic/v1/messages` route, with Hermes's own cache
  breakpoints and its five-minute cache. Other providers, the legacy runtime and the
  rehearsal fixture keep the OpenAI-compatible API.
- The broker reads the turn's scoped credential from Anthropic's key header on that
  route only, forwards to the configured Anthropic address with the provider key,
  and passes on only Hermes's two beta features.
- The Messages API keeps the OpenAI route's boundary: only locally executed tools, no
  hosted tools, containers, MCP servers, stored files or remote media, and unknown
  request fields are refused. Earlier reasoning is not replayed, as before. A model's
  own tool call arguments are literal text to the secret check, which masks them.
- Replies keep what they had: the same model, tools, thinking (no effort setting is
  sent, so the model keeps its own default), memory-notes review budget (counting
  cached input too), and step-limit summary (built with the turn's tools, as on the
  chat route).
- On the Messages API the memory evidence is the last block of the request, after
  Hermes's cache breakpoints, so no cached part holds it. The OpenAI route keeps it
  before the conversation.
- A profile remembers the prompt revision of each session, the last 500.
- The Hermes image includes Anthropic's SDK; starting the development stack rebuilds an
  image that fails the Dockerfile's import checks. Image reads stay on the
  OpenAI-compatible API, and Hermes's session search, titles and compression keep the
  broker's chat route.
</decision>

<consequences>
- Repeated calls within five minutes read the cached start at a tenth of the input
  price; the first call writes it at 1.25 times the input price. A single-call turn
  after a longer pause costs slightly more than before; multi-call turns, reviews and
  turns in a running conversation cost less.
- Each call re-sends the memory evidence uncached; everything before it, earlier turns
  included, is read from the cache.
- The model sees the same memory evidence at the end of the request instead of before
  the conversation.
- The secret check, privacy filter, image reads, Honcho and Hermes's one-shot helper
  calls are unchanged. Honcho's reasoning calls are a separate, later change.
- Usage shows the cached share of input per part.
</consequences>
