# Subscription compatibility gate

Phase 1 is **complete locally**. A fresh Hermes-owned login, live token refresh, native
chat, literal detection and Ogg/Opus transcription pass locally with the owner's
ChatGPT subscription. ADR-0019 defers VPS verification and selects local Compose
for development and acceptance. These paths also passed inside Compose. For the
current runtime, use `./scripts/nocheh verify`; the commands below reproduce the
original isolated Phase 1 investigation. See [current status](../TASK.md).

See [Hermes-owned login results](results/2026-09-06-hermes-local.json),
[initial access-token results](results/2026-09-06-local.json) and
[findings](findings.md). These checks establish compatibility, not production
readiness or general secret-detection accuracy. Earlier reports retain their
original pending-VPS status; ADR-0019 changes the gate, not those observations.

## Reproduce locally

Prerequisites: Git, Python 3, uv, Docker with a running daemon, FFmpeg/ffprobe,
and public network access. Tested with uv 0.12.7 and Python 3.11.16. Run from
the repository root:

```bash
python3 compatibility/setup.py
data/compat/hermes-venv/bin/python -m unittest compatibility.test_subscription -v
data/compat/hermes-venv/bin/python compatibility/probe.py --live
```

Setup fetches the exact revisions in `upstreams.lock.json`, synchronizes Hermes's
locked dependencies, and pulls the tested transcription image by digest. Source,
virtualenv, cache, login state and working reports stay under ignored `data/compat/`.
`setup.py --skip-image` prepares the offline tests without Docker. Existing source
checkouts must match the lock and have no tracked modifications or `.env` file.

The default live probe reads only the current access token in `~/.codex/auth.json`.
It never copies or rotates that application's refresh token. Each run uses a
temporary Hermes profile with only Nocheh enabled and no provider API keys.
Native plugin discovery registers the STT provider; the probe substitutes a
Docker runner for the in-container `codex-asr` binary.

The committed fixture contains synthetic English speech in a Telegram-style
Ogg/Opus container. Its transcript, provenance and checksum are in
`fixtures/subscription-speech.json`. ffprobe checks for actual audio frames before
upload. No Telegram messages, private corpus, paid provider keys or local
transcription model are used.

Live probes consume subscription quota. `--only chat`, `--only detector` and
`--only transcription` isolate a failed check; `--output PATH` preserves a report.
Reports expose status, timings and synthetic-content checks, without tokens or
upstream error bodies.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | All required Phase 1 live checks passed on the selected local or VPS target |
| 1 | A check failed |
| 2 | No selected check failed, but required checks remain pending or unselected |

Offline tests must also pass before marking Phase 1 complete. A zero live-probe
exit code does not complete later production phases or authorize cutover by itself.

## Verify a Hermes-owned login and refresh

```bash
data/compat/hermes-venv/bin/python -u compatibility/login.py
data/compat/hermes-venv/bin/python compatibility/probe.py --live --auth-source hermes --output data/compat/hermes-local-report.json
```

Complete the device login in the browser. This creates a dedicated Hermes login
at `data/compat/hermes-auth/auth.json`; credentials never enter Git. The helper
uses Hermes's native device flow and token store. The probe then calls Hermes's
native token-refresh and persistence functions before exercising the refreshed
credential in chat, detection and STT. It does not use the generic resolver's
legacy fallback to another application's credential store.

If OpenAI asks to enable device-code authorization, enable it in ChatGPT's
Security settings and restart the login helper for a new code. Once this profile
has a login, run the probe directly; another browser login is not required.

The production plugin delegates ongoing credential resolution/refresh to Hermes.
In Compose, mount only its owned profile; do not share the Codex
desktop application's refresh-token file between processes.

## Verify on the target VPS

Use the same checkout and prerequisites on the selected Linux VPS. No Nocheh
deployment target has been supplied yet; running the transcription image on a
local Docker VM does not count as VPS verification.

```bash
python3 compatibility/setup.py
data/compat/hermes-venv/bin/python -m unittest compatibility.test_subscription -v
data/compat/hermes-venv/bin/python -u compatibility/login.py
data/compat/hermes-venv/bin/python compatibility/probe.py --live --auth-source hermes --environment vps --output data/compat/vps-report.json
```

VPS work remains deferred by ADR-0019. Retain a sanitized report when a VPS
is available; do not report that future check as passed. A failed required transcription check
blocks release; this harness never selects a paid API or local model as fallback.

## What the tests establish

- Real Hermes plugin discovery and transcription dispatch, including preservation
  of Unicode, whitespace and line endings.
- Simulated 401/403/429/503, timeouts, invalid responses and missing audio, with
  classified failures and no fallback provider or internal retry loop.
- Simulated native token rotation/persistence and quota handling during refresh;
  the audio upload makes zero requests when credentials are unavailable.
- Literal-only detector contract validation and rejection of rewritten values.
- Incomplete live reports cannot pass the phase gate.

The offline suite prevents socket connections. Its simulated failures and refresh
tests are explicitly separate from live results. Retry queues, durable archive
storage, complete-request guarding and group isolation have their own runtime
acceptance tests under `./scripts/nocheh test`.
