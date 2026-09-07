# Owned archive and durable capture

Native Hermes long polling is wrapped at the Telegram HTTP response boundary.
The wrapper fsyncs every update before returning it to python-telegram-bot; only
then can the next poll acknowledge it. Cold starts and reconnects retain pending
updates. Webhook mode is rejected until it has equivalent durable capture.

The worker commits immutable, idempotent events to PostgreSQL, then removes the
spool entry and fsyncs its directory. A database failure leaves the original on
disk. Malformed or conflicting entries stay visible in `/v1/status`; bounded
round-robin processing prevents them from starving later entries.

`events.payload` retains the original JSON values, including unrecognized fields.
`original_text` is UTF-8 bytes, preserving whitespace, Unicode, line endings and
NUL characters. Exact Telegram response bytes are separate `telegram_wire`
events. Search text is a derived index; it is never the source of an export.
Observed edits are separate revisions. Telegram updates the bot never receives
(including unavailable deletion notifications) cannot be reconstructed.

Attachments keep source IDs and metadata. Downloads are retried with capped
backoff, saved by SHA-256 under `files/`, and fsynced before their database state
becomes `ready`. Unretrievable files remain `failed` with attempt counts and a
next retry time. Provider transcripts and other extracted text belong in
`derived_artifacts` with provenance; they never replace an original message.

Outbound requests have fsynced intents and results, including original parameters
and response bytes. A missing result after restart is `ambiguous`; the same send
cannot be blindly retried. Confirmed results are reused when native code retries.
Journal records remain outside the pending spool for restart reconciliation.

Live update events receive a dispatch record in the same database transaction.
Native Telegram handlers reject updates unless invoked by the committed dispatch
path. Imports, wire captures and outbound records are suppressed. The assistant
uses committed originals and separately recorded transcripts. Archive capture,
attachment downloads, assistant work and approved actions have independent retry
loops; a slow model request does not block archive ingestion or downloads. A loop
never overlaps itself. Malformed live source messages stay archived with a visible
suppressed dispatch, allowing later work to continue.

Committed media uses native Telegram event decoding and replies. The integration
bypasses native duplicate downloads and sticker vision preprocessing; those paths
would operate outside the scoped assistant process. Voice, audio and round video
notes use the archived transcript path. Photos, stickers and documents are archived
with their captions and source references; automatic image/document interpretation
is not enabled in this release.

## Verification

`./scripts/nocheh test` starts PostgreSQL, runs isolated-schema archive and
HTTP tests inside the development image, and runs Python tests against the pinned
native Telegram adapter. The suite covers duplicates, edits, original text,
failed attachment downloads, historical suppression, capture disk failure,
cold-start/reconnect behavior and ambiguous sends across restart.

On 2026-09-06, an actual Compose PostgreSQL stop/start also passed: a synthetic
event remained fsynced throughout the outage, recovered automatically as one
unchanged archive record, and retained its suppressed historical dispatch.
No live Telegram account has been exercised yet.
