# ADR-0035: Share CLIProxyAPI reasoning and monitor it with CPA Manager Plus

Accepted by the owner, 2026-09-09. Implementation status is in `TASK.md`.

Run one pinned CLIProxyAPI service for Hermes and Honcho reasoning. Complete one
fresh ChatGPT device login in that service; do not copy the existing Hermes login.
CLIProxyAPI is the only owner of its OAuth store and the only process allowed to
refresh it. Give each internal consumer a different proxy API key so monitoring can
attribute traffic without creating another ChatGPT login. Paid reasoning fallback
and unrelated provider credentials remain prohibited.

All model content still passes through Nocheh's audience and current-revision guard
before each attempt. Configure the shared proxy with one credential, no provider or
model fallback, no quota switching and no additional request retry rounds. A 401 may
refresh the credential, but replaying the model request must return through Nocheh's
guard boundary. Preserve the native Hermes provider only as an inactive rollback
until acceptance; never run a second refresh owner.

Transcription continues through the pinned `codex-asr` implementation and official
subscription speech endpoint. A trusted speech boundary may read the proxy's current
access token from a read-only mount. It must not receive or copy the refresh token,
modify the auth store, or expose the token to an agent process. This keeps one sign-in
while recognizing that CLIProxyAPI does not provide the required speech route.

Run CPA Manager Plus Full Mode as a separate local Compose service, pinned at
`1ae656c82990c480f3f104326a08c6e0001eeb4c`. It persists request history, usage,
latency, failures and account/quota observations in its own SQLite state. Nocheh
proxies its panel and APIs behind the existing owner session, supplies its admin and
management credentials server-side, and does not expose either key to browser
storage. Automatic credential actions, external notifications and request-body
logging are disabled. Monitoring failure does not block inference.

Honcho retains the separately paid embedding route, its durable $5 pilot/monthly
admission ledger and all existing guarded-memory gates. A shared reasoning login does
not make the currently failing embedding check pass or authorize attachment.

