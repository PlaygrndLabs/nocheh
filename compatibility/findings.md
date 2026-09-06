# Phase 1 findings — 2026-09-06

**Status:** Hermes-owned device login, live refresh and all three core subscription
paths pass locally. Phase 1 is complete under ADR-0019: the owner chose local
Compose and deferred VPS verification. Container acceptance follows in Phase 2.

| Check | Actual result |
| --- | --- |
| Native Hermes `AIAgent`, `gpt-5.6-sol`, no tools | Live pass with refreshed Hermes credentials; sentinel matched, one API call, 6.40 s |
| Literal detection via Hermes `CodexAuxiliaryClient` | Live pass with refreshed credentials; planted password found exactly and clean prose produced no matches, two requests together 6.14 s |
| Native plugin discovery → native STT dispatcher → pinned codex-asr image | Live pass with refreshed credentials; 7.25 s Ogg/Opus fixture transcribed, expected spoken terms present, 5.91 s including process startup |
| Offline contracts against pinned native interfaces | 21 tests passed; failure/quota responses are simulated |
| Dependency setup | Passed locally with pinned source, dependency lock and image digest |
| Hermes-owned refresh against live auth endpoint | Live pass; native refresh and persistence completed in 1.63 s, then all three model paths passed |
| Target VPS | Deferred by owner; local Compose is the current target (ADR-0019) |

The local run used macOS arm64 for Hermes and the pinned Linux transcription
container. Timings are individual observations, not performance benchmarks. The
fixture contains a synthetic password/access code, not a real secret. Two detector
examples do not establish detection recall or prove that every secret is found.

## Compatibility issues resolved

1. Initial speech synthesis under the filesystem sandbox produced a container
   with no audio frames. ChatGPT correctly returned HTTP 400, `Unable to determine
   audio duration`. Regenerated the fixture and added a duration/codec preflight.
2. The account rejected `gpt-5.4` with HTTP 400. The live account catalog listed
   `gpt-5.6-sol`; native chat with that model passed, so it is the tested model pin.
3. At the pinned Hermes revision, the generic auxiliary router's
   `_resolve_openai_codex_branch` ignores its explicit OAuth argument and reads
   Hermes's own store instead. An isolated access-token probe therefore reported
   missing credentials. The thin detector uses Hermes's existing
   `CodexAuxiliaryClient` with an explicitly authenticated SDK client and native
   request identity headers. No custom wire protocol, paid key or upstream patch
   was needed for this compatibility check.
4. The first completed device login exposed a helper bug: Hermes returns a
   metadata envelope, while its persistence helper expects the nested token map.
   Corrected that mapping and repaired the saved login without another sign-in.
   Regression tests verify native credential reads and protect existing credentials
   from an incomplete login response. The repaired credentials refreshed live.

Native code inspected at the pin:

- [Hermes transcription provider interface](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/agent/transcription_provider.py)
- [Hermes native STT dispatcher](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/tools/transcription_tools.py)
- [Hermes auxiliary adapter and routing](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/agent/auxiliary_client.py)
- [Hermes OAuth ownership and refresh](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/hermes_cli/auth_codex.py)
- [codex-asr request construction](https://github.com/Wangnov/codex-asr/blob/479f6a7a3db81fe2a23d4755b0ccbeb4400317d4/src/lib.rs)

## Remaining scope

No real quota exhaustion was deliberately induced. Actual malformed/unsupported
requests produced HTTP 400; rate limits, expired authentication and transient
errors were exercised with offline transport responses. Live refresh and requests
with the refreshed Hermes-owned credentials now pass. See the
[sanitized report](results/2026-09-06-hermes-local.json).

The archive, optional guard enforcement, Telegram capture, group scoping, retry
worker and VPS deployment are not implemented by this checkpoint. The Honcho
experiment has not started and its API budget has not been used.
