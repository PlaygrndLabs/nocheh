# Rebuild progress

The owner requested a fresh start on 2026-09-07. Local Nocheh services are stopped;
runtime data, backups, logins, generated dependencies/build files, project Docker
volumes and Nocheh-built images were removed. `.env` is a credential-free template.
The rebuild is **not released**: fresh setup, real Telegram acceptance, cutover
and the merge to `main` remain pending.

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work: `codex/hermes-rebuild`.
No legacy data migration is required. VPS work is deferred by ADR-0019.

| Phase | Actual status |
| --- | --- |
| 0 — Preserve baseline and architecture | Complete: `add2341` |
| 1 — Subscription compatibility | Complete locally: `8fd69cc` |
| 2 — Compose runtime | Complete: `9d72c32` |
| 3 — Durable capture and archive | Complete: `d29dbab` |
| 4 — Import, search, export, replay | Complete: `aa39e60` |
| 5 — Optional outgoing guard | Complete: `eb6d319` |
| 6 — Scoped assistant and voice | Implemented at `43eea5e`; native/offline checks pass; real Telegram acceptance pending |
| 7 — Honcho comparison, maximum $5 | Runnable harness at `2d27262`; live comparison pending separate credentials; optional |
| 8 — Operations, cutover, merge | Backup/restore implemented at `4efe7c3`; real Telegram gate, cutover and merge pending |

## Last validation before the reset — 2026-09-07

- 14 TypeScript tests pass against real Compose PostgreSQL where required;
  30 Python native integration/operations tests pass. No main-suite skips.
- 21 subscription contracts pass with simulated transport failures. Five Honcho
  budget/scoring tests pass; no paid requests or live comparison occurred.
- Live subscription refresh, native chat, literal detection and Ogg/Opus
  transcription pass again after configuration and worker cleanup.
  [Latest report](compatibility/results/2026-09-07-cleanup-subscription.json).
- Native memory store, recall across process restarts and another-group isolation
  passed the [synthetic live rehearsal](compatibility/results/2026-09-07-assistant-memory.json).
  Recall reached 152 seconds in that run; it is not a latency guarantee.
- Required guard failure/retry/redirect tests pass. Native guarded chat passed
  again after cleanup with one required boundary attempt and no guard failures;
  the saved `auto` policy is restored. Earlier transient failures remain in the
  [historical guard report](compatibility/results/2026-09-07-guard.json).
- `.env` configuration checkpoint `4f3fade` preserves archive credentials and keeps
  Hermes OAuth in its native file. Format-2 backup/restore matched eight table
  fingerprints and 38 state files; five restored services were healthy and inactive.
  The rehearsal is stopped. [Report](compatibility/results/2026-09-07-environment.json).

## Cleanup and behavior fixes

The retired application is recoverable on the legacy branch. Its remaining local
`web/` build output and dependencies were removed. Active documentation describes
this runtime; historical research and accepted ADRs remain available.

Edit only the ignored root `.env` for local configuration. The requested fresh
reset removed the entire `data/` directory, including previous configuration,
archive files, backups, experiment state and the dedicated Hermes login.
Committed synthetic evidence and historical decisions remain in Git.

Archive capture, attachments, assistant work and approved actions progress in
independent non-overlapping loops. Slow inference cannot block capture/downloads.
Committed media avoids native duplicate downloads and unscoped sticker vision;
round video notes use the transcript path. Malformed source messages remain
archived with a visible suppressed dispatch and do not starve subsequent work.

## Remaining release gates

Run `./scripts/nocheh up` and `./scripts/nocheh login` for a fresh runtime and
dedicated subscription login. Set the bot token, owner ID and selected groups in `.env`; follow
[Telegram setup and acceptance](docs/telegram.md). Actual DM/group replies and
silence, private/group isolation, voice persistence, owner-approved delivery and
reconnect/restart checks are **unrun**. Container health does not prove these.
Do not merge until they pass; commit the completed phase and proceed automatically.

The optional [Honcho experiment](experiments/honcho/README.md) needs a separate
bridge login and an explicitly supplied temporary key. Live compatibility,
derivation and recall comparison remain pending. Its $5 budget is unused.
