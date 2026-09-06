# Phase 1 findings — 2026-09-06

**Status:** three core subscription paths pass locally; Phase 1 remains open for
Hermes-owned live refresh and VPS verification. No runtime replacement or merge
into `main` has occurred.

| Check | Actual result |
| --- | --- |
| Native Hermes `AIAgent`, `gpt-5.6-sol`, no tools | Live pass; sentinel matched, one API call, 9.44 s |
| Literal detection via Hermes `CodexAuxiliaryClient` | Live pass; planted password found exactly and clean prose produced no matches, two requests together 7.54 s |
| Native plugin discovery → native STT dispatcher → pinned codex-asr image | Live pass; 7.25 s Ogg/Opus fixture transcribed, expected spoken terms present, 6.31 s including process startup |
| Offline contracts against pinned native interfaces | 19 tests passed; failures/quota/refresh responses are simulated |
| Dependency setup | Passed locally with pinned source, dependency lock and image digest |
| Hermes-owned refresh against live auth endpoint | Pending browser device login |
| Target VPS | Pending host/user/application directory and access |

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

Native code inspected at the pin:

- [Hermes transcription provider interface](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/agent/transcription_provider.py)
- [Hermes native STT dispatcher](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/tools/transcription_tools.py)
- [Hermes auxiliary adapter and routing](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/agent/auxiliary_client.py)
- [Hermes OAuth ownership and refresh](https://github.com/NousResearch/hermes-agent/blob/7166071fcaadb36df26f6d753dda97da6b5d699e/hermes_cli/auth_codex.py)
- [codex-asr request construction](https://github.com/Wangnov/codex-asr/blob/479f6a7a3db81fe2a23d4755b0ccbeb4400317d4/src/lib.rs)

## Remaining scope

No real quota exhaustion was deliberately induced. Actual malformed/unsupported
requests produced HTTP 400; rate limits, expired authentication, transient errors
and refresh rotation were exercised with offline transport responses. Live
refresh must still prove that newly issued Hermes-owned credentials work.

The archive, optional guard enforcement, Telegram capture, group scoping, retry
worker and VPS deployment are not implemented by this checkpoint. The Honcho
experiment has not started and its API budget has not been used.
