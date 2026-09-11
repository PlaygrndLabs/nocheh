# ADR-0020: Guard the serialized request at the pinned HTTPX boundary

Accepted, 2026-09-07. Implements ADR-0018's optional guard.

Hermes plugin callbacks do not establish a mandatory boundary for all auxiliary
calls and retries. Install a small compatibility shim before creating any native
agent or provider client. Pin HTTPX 0.28.1 and the tested Hermes revision; reject
unexpected boundary signatures or unsupported transports at startup/use.

Inspect each physical synchronous and asynchronous HTTPX attempt, including
redirects, after the SDK assembles the complete JSON body. This covers native
Responses, Chat Completions and Anthropic Messages SDKs. Refuse Bedrock, MoA and
Codex app-server transports. Enabled assistant tools must not offer arbitrary
code execution or alternate network clients; this shim is not an OS sandbox.

`off` bypasses guarding; `on` requires it; `auto` requires it unless the exact
destination origin and path prefix are explicitly trusted. The default trusted
prefix is `https://chatgpt.com/backend-api/codex`. Model names confer no trust.
Required guarding fails closed before the physical send. The detector itself
has a narrowly scoped exemption for that trusted subscription destination.

Nocheh's guard service combines literal detection with local patterns, validates
literal membership and span boundaries, merges overlaps and replaces spans with
`***`. All other string characters remain unchanged. Originals remain in the
archive. Versioned cache records share the archive database and are derived data.

Opaque server-side context and media cannot be guarded as text. Required mode
rejects them. The pinned Responses shim drops encrypted reasoning sidecars from
the outgoing derived view so the clear conversation history can be replayed;
stored native history remains unchanged. Raw transcription follows its separate,
explicitly trusted subscription route. Known OAuth, Telegram transport and Codex
model-list operations are operational exemptions, not inference destinations.

Detection is fallible. Exact masking is a tested invariant; detecting every
possible secret is not. Transport tests and synthetic detection quality results
are reported separately. Upstream upgrades require repeating compatibility tests.
