# ADR-0010: Multimodal Ingestion, Per-Content-Type Model Roles, and a Model-Backed Secret Guard

## Status

Accepted

## Context

Three problems, discovered together.

**Images and voice notes were silently destroyed.** `TelegramUpdateMapper` typed
six fields and gated on `message.text`, so every media update returned
`undefined`. Because Telegram puts a media caption in `caption` rather than
`text`, even a photo *with* a caption was dropped. The webhook then answered
`200 {"ok":true}` with no log, no metric, and no audit record, so Telegram never
retried and the message was indistinguishable from one that never arrived. An
exhaustive search found no occurrence of `photo`, `voice`, `caption`, `getFile`,
`mime`, or `transcri` anywhere in `src/`.

**One model did every job.** A single `MemoryGraphAnalyzerPort` instance served
all four entry points with one model, one prompt, and one temperature. The
provider catalog carried exactly one `modelEnvKey` per provider. GLM-5.2 is text
only, so there was no seam through which a vision or speech model could be added,
and the two-tier policy in `docs/research/0003` had no code to attach to.

**Redaction was pattern matching only.** Seventeen regexes catch structured
credentials (`sk_live…`, a JWT, a PEM block, `postgres://user:pass@…`) with
certainty. They do not catch a credential phrased as prose. `password: hunter2`
matches; "the wifi password is hunter2" does not, because the pattern requires
`password` immediately followed by `:` or `=`. Speech is mostly prose, so
transcribing voice notes would have made that gap much more load-bearing.

## Decision

### Media becomes text before anything else looks at it

The Telegram mapper now reads `caption` and every media field, and a message
survives when it has text, a caption, **or** an attachment. Media-only messages
carry `text: ""` and their meaning lives in `attachments`.

`MessageAttachment` records identity and shape, never bytes. Telegram sends
photos in several resolutions, so all of them are kept as `variants`: perception
providers cap inline payload size well below a typical photo, and a smaller
rendition is better than a failed call.

The pipeline order is now:

```text
fetch attachment bytes -> perception model -> description + transcript
  -> secret guard over ALL text (typed, described, transcribed)
  -> text analysis
```

Bytes are never persisted. They are fetched, turned into text, and dropped. Only
derived text is cached, keyed on the platform's stable `file_unique_id`, so a
resent or forwarded file is not paid for twice.

Media understanding is never fatal. An attachment that cannot be fetched or
understood stays undescribed and the window is still analysed from its text.
Losing a description costs quality; failing the window would lose the
conversation.

### Model roles, one per content type

`AiModelRole` splits model selection into four independently configured,
independently degradable jobs:

| Role | Provider env key | Unset behaviour |
| --- | --- | --- |
| `text_analysis` | `AI_PROVIDER` | Dry-run; no knowledge produced |
| `image_understanding` | `AI_IMAGE_PROVIDER` | Images recorded, not described |
| `audio_understanding` | `AI_AUDIO_PROVIDER` | Voice notes recorded, not transcribed |
| `secret_guard` | `AI_GUARD_PROVIDER` | Pattern rules only |

Credentials stay per provider; only the model id is per role. Image and audio are
separate roles rather than one "media" role, so they can point at one omni model
or at two specialised ones. `AI_PROVIDER` keeps its name and meaning, so existing
setups are untouched.

Default wiring is `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` for both image
and audio. A Gemini adapter exists as the alternative, and is the answer for voice
specifically: Gemini accepts OGG/Opus inline, which is what Telegram sends, so it
needs no ffmpeg transcoding step. The project has exactly one runtime dependency
and adding a native media toolchain would be a large step to take on an unverified
assumption.

### The guard model detects; masking stays local

`LlmSecretDetector` asks the model for the exact literal substrings it believes
are secrets. Masking then happens locally in `redactLiterals`. The model never
returns rewritten text, because a model asked to rewrite will also quietly alter
wording and there would be no way to distinguish an edit from a redaction.

Consequences of that split, all deliberate:

- A hallucinated literal that does not appear in the text is ignored, so a bad
  answer is harmless rather than destructive.
- Literals shorter than four characters are rejected, so a model returning `"a"`
  cannot shred the message.
- A kind outside the domain vocabulary is ignored; a segment id outside the input
  range cannot corrupt another field.
- Unparseable output is a guard **failure**, not an empty result. Treating garbage
  as "no secrets found" would turn every model hiccup into a leak.

An entire window is inspected in one call, so guard cost is per window rather than
per field, including attachment descriptions and transcripts.

### Two detectors at two places, and fail closed

| Detector | Where | Role |
| --- | --- | --- |
| Patterns (existing, sync) | Per message, at buffer write, on the webhook ack path | Keeps an obvious credential out of storage. Not an analysis gate. |
| Guard model (new, async) | Once per window, before analysis | **Authoritative.** Catches prose and speech. |

When the guard is unavailable, `GuardedSecretDetector` applies pattern redaction
and then rethrows. The window stays buffered, nothing reaches the analysis model,
and the stall is written to the audit trail so it is visible rather than silent.
This is what "regex as emergency fallback" means in practice: patterns guarantee
at-rest safety, they do not unlock analysis. `SECRET_GUARD_ON_FAILURE=degrade_to_patterns`
exists as an operator escape hatch and is loud when used.

Two supporting mechanisms were required to make fail-closed safe:

- **Quarantine.** A message counts guard failures; after `SECRET_GUARD_MAX_ATTEMPTS`
  it is set aside, excluded from future windows, and kept for inspection. Without
  this a permanently failing window would stall a conversation forever and re-bill
  the guard on every attempt.
- **A flush sweep.** Nothing scheduled a flush before this change: `flush()` only
  ran when a new message arrived, so `LIVE_ANALYSIS_INTERVAL_SECONDS` effectively
  meant "interval elapsed *and* someone sent another message." A guard-failed
  window in a quiet conversation would never have been retried.

The webhook answers `200` on a guard failure rather than `500`. The buffer upserts
on `(conversation_id, message_id)` so a Telegram retry is safe, but a non-2xx would
make Telegram retry the same update and hammer an already-failing guard for no
benefit.

## What Live Verification Changed

Confirmed against the real NVIDIA catalog on 2026-08-02. `build.nvidia.com` is behind
a WAF that serves a JavaScript challenge instead of content, so none of this could be
read from the model cards; it was measured instead.

| Question | Result |
| --- | --- |
| `z-ai/glm-5.2`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `moonshotai/kimi-k2.6` | All present in `/v1/models` |
| Image content block | `image_url` with a base64 data URL works |
| Audio content block | **`audio_url`, not the OpenAI `input_audio` shape.** `input_audio` returns HTTP 400 |
| OGG/Opus, what Telegram sends | Transcribed correctly. No ffmpeg, no Gemini fallback needed |
| Declared mime type | Ignored; the endpoint sniffs the bytes |
| `response_format: json_object` | Works, and suppresses the reasoning trace (89 vs 462 output tokens) |
| Inline payload cap | None observable. 8MB raw / 10.7MB base64 accepted |

Two assumptions were wrong and are corrected in the code: the audio block shape, and
a ~180KB inline cap that does not exist. The cap mattered because honouring it
downscaled photos and cost OCR accuracy for no reason; `MEDIA_MAX_INLINE_BYTES` now
defaults to 5MB so the best rendition is normally sent.

**The perception prompt's credential instruction is honoured inconsistently.** A
spoken password was replaced with `[credential omitted]`, but a password written on a
photographed whiteboard was transcribed verbatim. This is why it is described above as
defence in depth rather than protection: the guard caught the leaked credential and
nothing reached storage.

**A prompt naming more than one modality confuses the omni model.** With a prompt
mentioning both image and audio it replied "No attachment provided." for a clip it had
received, or called an audio clip "the image", in roughly a quarter of runs. Prompts
are now per kind, after which six consecutive runs succeeded. A model that reports it
could not perceive the attachment raises `MediaNotPerceivedError`, so the non-answer is
never cached as a description.

**Analysis is by far the slowest step.** A two-message window with media descriptions
took 189-240 seconds against `z-ai/glm-5.2`, close enough to Node's own 300 second
socket timeout to surface as an opaque `fetch failed`. Every adapter now carries an
explicit timeout budget and names the call that gave up.

**Small reasoning models spend hidden tokens.** The guard returns ~60 tokens of JSON
but measured ~510 output tokens getting there. A 1024 ceiling truncated
intermittently, and a truncated guard means a stalled window, so the guard budget is
now 4000.

**Guard model choice matters more than expected.**
`nvidia/nvidia-nemotron-nano-9b-v2` found every planted secret with no false
positives. `nvidia/nemotron-3-nano-30b-a3b` returned `{"segments": []}` for the same
input. A guard that silently finds nothing is worse than none, so a candidate must be
evaluated before it is trusted.

## Verified Behaviour Of The Whole Chain

One live run of `executeWindow` over two messages carrying only a captioned photo and
a voice note — no plain text content:

```text
media_fetch            8436ms  attempted=2 understood=2      (2198 tokens)
media_understanding    8436ms  understood=2 failed=0
secret_detection       8265ms  findingCount=1 segmentCount=4 found_password=1
redaction              8265ms  redacted=true
analysis             188933ms  memories=1 tasks=2            (3194 tokens)
memory_persistence        1ms  recordCount=1
persistence               2ms  2 tasks
```

The whiteboard photo's credential was transcribed by the perception model, caught by
the guard, and stored as `admin / [REDACTED:password]`. The literal password appears
nowhere in the audit record or the persisted tasks. Knowledge was extracted purely
from an image description and a voice transcript, including a deadline change that
only made sense by combining both.

## Consequences

**Raw media reaches the perception provider unredacted.** A JPEG cannot be
regex-scanned, so some model must see a photographed password or a spoken key
before redaction is possible. This is placed, not solved: whichever provider fills
the image and audio roles is trusted with raw content.

**Cost per window rises** from one call to `1 + N_media + 1 guard`. Measured for the
run above: 2198 perception + ~950 guard + 3194 analysis tokens. Bounded by a
per-window attachment cap, the understanding cache, a guard input character cap, and
batch mode amortising the text call.

**Availability now depends on the guard model** under the default policy. That is
the intended trade and the reason quarantine, the sweep, and the escape hatch
exist.

**Analysis latency does not fit inside a webhook.** In batch mode the flush runs
inside the Telegram request, and a ~200 second analysis will exceed Telegram's own
webhook timeout, so Telegram retries while the first flush is still running. The
buffer upserts on `(conversation_id, message_id)` so nothing is lost or duplicated in
storage, but the analysis call can be paid for twice. The flush sweep added here is
the mechanism that fixes this properly — moving the flush entirely off the request
path — but that change is not made yet.

**Graph nodes, edges, and suggestions are dropped in practice.** The analysis prompt
documents the value shape for `tasks`, `memories`, and `statusUpdates` but not for
`nodes`, `edges`, `strategicSuggestions`, or `actionSuggestions`. GLM-5.2 therefore
invents plausible but non-conforming shapes — `{type, title, project}` for a node
where the domain wants `{id, kind, label, scope, payload}`, and a bare string for a
suggestion where the domain wants `{kind, title, rationale}`. Every such item is
dropped. This predates this ADR and was invisible because nothing had run a real
window; it now degrades per item with the reason recorded in the audit trail instead
of failing the whole window. Populating the graph requires documenting those shapes
in the prompt, ideally generated from the domain vocabularies so they cannot drift.

**Item-level tolerance replaced all-or-nothing validation.** A single malformed item
used to reject an entire window, discarding every other piece of extracted knowledge
with it. Structural problems — a non-object root, a required key that is not an array
— still reject loudly.

**Source references are resolved locally, not trusted from the model.** GLM-5.2
returns `source` as `{ messageId }` alone, which the old validator rejected as
incomplete. Platform, conversation id, and timestamp are known from the window, so
they are filled in from it. This is cheaper in tokens and removes any way for a model
to attribute knowledge to the wrong conversation. An unrecognised messageId falls
back to the window anchor rather than discarding the item.

**Graph source ids no longer inherit the graph-id minimum length.** A Telegram
`message_id` starts at 1 in every chat, so the old three-character minimum made the
first hundred messages of any conversation unpersistable. Source identifiers now only
have to be non-empty and whitespace-free.

