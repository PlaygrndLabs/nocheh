# ADR-0193: Voice notes are transcribed by the runtime's transcriber

<status>
Accepted on 2026-10-29 as part 2 of the chat-review build the owner approved
("I all thing is ready start build."). This is the later owner decision
[ADR-0142](0142-external-providers-only.md) waited for: "we need have voice
trancrition for all voices", with OpenAI and the existing key chosen as the
provider. Supersedes the voice-note part of ADR-0142; extends
[ADR-0192](0192-files-are-read-by-the-runtime-document-reader.md).
</status>

<context>
- Voice notes kept only their audio and a "transcription is not available"
  status, so their content could not be searched, answered or learned.
- Hermes 0.22.5, which Nocheh pins, already transcribes voice notes for its
  own gateway: it converts audio a provider rejects, trims silence, splits
  recordings longer than a model accepts, and knows OpenAI's transcription
  models. Its image has ffmpeg and the OpenAI client.
- Nocheh is a wrapper over such tools: it adds its policy (the original kept,
  the secret check, cost tracking) and builds nothing they already do.
</context>

<decision>
- Settings › Models has a Voice notes row: an OpenAI-compatible provider
  (OpenAI by default, with its key) and one of the models Hermes knows
  (`gpt-transcribe` by default). Their prices per minute are listed in Nocheh,
  like the memory search prices. Apply passes the route to the runtime only.
- Preparation sends each voice note, audio file and round video, live or
  imported, to the runtime's `voice.transcribe` operation (Hermes:
  `/internal/transcribe`). The runtime runs Hermes's `transcribe_audio` in a
  child process with a Hermes home of its own, holding only that provider's
  key, with a ten-minute and 2 GiB limit. The reply profile keeps transcription
  off.
- The transcript is a derivative like any other: saved beside the original and
  checked for secrets before any use. A reply waits for it.
- A busy, rate-limited or unreachable provider makes the preparation step fail
  so the workflow tries again. Silence, an unsupported format, an oversized
  recording or another provider refusal becomes a status reading, so the reply
  goes on.
- Without a provider key a recording keeps the archived status. A worker loop
  asks the runtime once a minute whether a key exists, then transcribes such
  recordings five at a time, each once, and selects the transcript, which then
  shows instead of the status.
- Each transcription counts in the usage tracker as the Voice notes part, with
  its audio length and its cost from the per-minute price. An import's preview
  adds the minutes of its voice notes and what transcribing them costs.
</decision>

<consequences>
- Voice content becomes searchable, answerable and learnable after the secret
  check; Telegram Desktop exports' voice messages, audio files and round videos
  count as recordings too.
- Audio reaches the chosen transcription provider, which is the one exception to
  Anthropic-only models; the owner can change or remove it in Settings.
- A Hermes upgrade can change the transcriber, so each upgrade reruns the
  transcriber check with a made-up recording.
</consequences>
