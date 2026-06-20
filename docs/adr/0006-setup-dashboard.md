# ADR-0006: Setup Dashboard and Chat-Flow Visualization

## Status

Accepted

## Context

The assistant has matured through Phase 1 (core processing), Phase 1.5
(observability) and Phase 2 (structured memory), but it can only be bootstrapped
by hand: an operator must edit environment variables, register the Telegram
webhook with a manual API call, and supply history exports through code. There
is no way to dry-run the pipeline without sending real Telegram traffic, and the
only visibility into processing is the read-only inline-HTML console at
`GET /dashboard`.

We need an operator-facing dashboard that makes the app self-serviceable:

- add the AI API key,
- connect a Telegram bot (validate the token, register the webhook),
- import old group history,
- configure per-group assistant settings,
- inject mock messages to dry-run the pipeline, and
- visualize conversations and the step-by-step processing flow.

This must be added without coupling the existing hexagonal core to a web
framework, and without weakening the security policy in AGENT.md.

## Decision

Add a React single-page application served at a new `/app` route, backed by a
small JSON API mounted on the existing raw Node.js `http` server. The current
`GET /dashboard` observability page is left untouched.

Backend (inbound adapters only, no business logic added):

- A minimal `Router` (`src/interfaces/http/router.ts`) provides method + path
  matching, `:param` extraction, query parsing, JSON body parsing and JSON
  responses. No web framework is introduced.
- A static file handler (`src/interfaces/http/create-static-handler.ts`) serves
  the built SPA under `/app`, with a path-traversal guard and SPA fallback.
- JSON route factories under `src/interfaces/http/api/` translate requests to
  existing services. They reuse `LiveMessageBufferService` (mock injection and
  flush), `HistoryImportService` (backfill), `SqliteGroupAssistantSettingsRepository`
  (settings), and `AuditRepositoryPort` + `MetricsCollectorPort` (visualization).
- An `EnvStorePort` with a comment-preserving `DotenvFileStore` persists
  configuration to a gitignored `.env`.
- A `TelegramClientPort` with `TelegramHttpClient` performs outbound `getMe`,
  `setWebhook` and `getWebhookInfo` calls. Connecting a bot validates the token
  with `getMe`, registers the webhook with `setWebhook`, then persists the token
  and webhook URL to `.env`.

Secrets policy:

- The AI API key and Telegram bot token are written to `.env`. The API exposes
  configuration presence only (`"set"` / `"unset"`), never secret values.

AI scope:

- The AI key is stored for later use. The live pipeline continues to use the
  existing rule-based extractors; no concrete `AssistantAiPort` adapter is wired
  in by this change.

Frontend:

- A separate `web/` workspace built with Vite + React keeps frontend
  dependencies out of the backend runtime. In development, the Vite dev server
  proxies `/api` to the backend (same origin, no CORS). For integration and
  production, the SPA is built and served as static files by the backend.

## Consequences

Positive:

- The app can be bootstrapped, configured and dry-run entirely from a UI.
- Mock injection reuses the exact processor path the Telegram webhook uses, so
  the dashboard exercises real pipeline behavior.
- The chat-flow visualization is built from existing audit records, requiring no
  new persistence and no change to the domain or application layers.
- Frontend tooling is isolated in `web/`; the backend runtime image stays free
  of React/Vite.
- The existing `/dashboard`, webhook, and processing pipeline are unchanged.

Tradeoffs:

- A second toolchain (Vite/React) and a second test runner (Vitest, for the
  frontend) are introduced alongside the backend `node:test`.
- Serving an SPA from the raw `http` server requires a hand-rolled static
  handler, including a path-traversal guard.
- Most environment variables are read once at boot, so changes saved through the
  dashboard require a restart to take effect (the Telegram token used for the
  immediate connect call is the exception).
- The conversations view is reconstructed from a bounded window of redacted
  audit records, not a full chat scrollback.

## Guardrails

- Never return secret values over the API; expose configuration presence only.
- Persist secrets only to the gitignored `.env`; do not log them.
- `.env` writes must preserve existing comments, blank lines and ordering.
- Restrict writable environment keys to an explicit whitelist.
- Do not add permissive CORS to the backend; rely on the Vite dev proxy for
  local development.
- Do not introduce a raw-message store for the chat view; reconstruct it from
  redacted audit records to honor "store knowledge, not chat history."
- Validate the Telegram token with `getMe` before calling `setWebhook`.
- Keep the SPA static handler constrained to its root directory (reject `..`).
