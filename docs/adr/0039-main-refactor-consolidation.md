# ADR-0039: Consolidate the refactor into main

Status: accepted by explicit owner request. Date: 2026-09-11.

The owner requested merging the worktrees and moving all refactor changes to
`main`. Main becomes the baseline for the current local Docker Compose product.
This supersedes the branch and merge sequencing in ADR-0018, the rebuild plan and
the runtime-platform plan. It does not declare a release or complete missing
acceptance checks.

Both memory branches (`codex/memory-space-policies` at `4b6cf2f` and
`codex/integrate-space-memory` at `e4442a6`) are already ancestors of
`codex/hermes-rebuild`. The uncommitted controlled-tools draft in the integration
worktree predates the completed P5 implementation at `75f7c39`; its differences
are unfinished behavior subsequently fixed there. Preserve the draft as a Git
stash before retiring the temporary worktree, rather than replacing the finished
implementation with it. The detached legacy worktree at `dc84957` is already in
legacy/main history and contributes no additional refactor commits.

The draft is preserved as stash `f4e3bcee`. Before retiring the two temporary
memory worktrees, complete copies of all files and symlinks (including ignored
test state) were archived and verified under the ignored
`data/worktree-archives/2026-09-11/` directory. Their branches remain available.

Commit the pending provider acceptance, Telegram recovery, owner monitoring and
OAuth callback changes, verify the consolidated tree, then merge it into local
`main`. Preserve `codex/legacy-nocheh` at `9dd0b58` and the refactor branch history.
Subsequent development uses `codex/` branches from main.

At integration the shared-provider login count is zero. The tested native
subscription route remains active; live shared-provider cutover, dedicated Honcho
embedding/memory activation and the remaining Telegram release checks retain
their pending status in `TASK.md`. Inngest remains a proposed migration.
No release tag or provider activation follows from this Git consolidation.

Pre-merge verification passes 57 service tests and 125 Hermes tests, with one
optional Docker security fixture skipped. A failing service test exposed the
memory-review worker's database-wide advisory lock colliding with another schema's
worker. Scope that lock to the current schema, consistent with guard preparation
and Honcho; assert that same-schema runners exclude each other while another
schema cannot block progress. The AST graph is rebuilt without model calls.

The remote fetch failed because local GitHub HTTPS authentication is unavailable.
This decision authorizes the local main merge; it does not claim a remote update.
