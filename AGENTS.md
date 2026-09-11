<agent_instructions>

# Nocheh

<context>

Nocheh is a personal AI brain with Hermes as its first replaceable runtime.
Telegram is an adapter; owned source data, useful memory, and reasoning are the product.

- Read [SPECS.md](SPECS.md) for the authoritative product requirements and [TASK.md](TASK.md) for implementation status, blockers, and evidence. Specifications do not claim implementation or activation.
- Read the applicable code before relying on implementation descriptions. Plans under `docs/` provide execution order and acceptance procedures; [ADRs](docs/adr/README.md) explain decisions and their supersession history.
- Follow explicit user instructions. Record new durable requirements in `SPECS.md` and new working instructions here. Do not infer product changes from incidental code behavior or historical plans.

</context>

<specification_maintenance>

- `.md` files that AI writes and reads are plain-text context for AI, not documents that need one fixed format. Use XML for semantic structure and Markdown for content within that structure. Keep meaningful containers; avoid unnecessary leaf tags. Plain text can remain wherever neither adds clarity.
- `SPECS.md` is the durable definition of what Nocheh has to be and do. Collect every user prompt that counts as a spec there. Nest each area inside the area that contains it.
- A spec cannot stay verbatim when the prompt is a directive or request to change something. Convert it to spec-definition language, but keep the user's wording, do not paraphrase too much, and stay faithful to what they typed. Use the same wording fidelity for instructions the user asks to add here.
- Specs must be stateless and absolute: each spec defines the intended target independently of the implementation's current or previous state and remains meaningful as implementation changes.
- Do not preserve relative statements such as “the current size is right,” “keep it as is,” or “it remains unchanged” as specs. Convert them to explicit absolute requirements only when the intended requirement is known. Otherwise omit the uncertain wording and record the clarification needed in `TASK.md`.
- When adding or changing specs, audit related existing specs for state-dependent or ambiguous wording. Remove uncertain relative wording without silently removing an established requirement. Resolve ambiguity with the user; do not invent a replacement.
- Keep dates, commit hashes, progress, temporary failures, migration steps, and proposals in `TASK.md`, execution plans, or ADRs. Do not promote a proposal into the product definition without acceptance.
- Update specs with the feature, not as a later cleanup. Avoid duplicating product rules here or in active plans. Record new architectural decisions in new ADRs; preserve accepted historical ADRs unchanged.

</specification_maintenance>

<repository_workflow>

- For each new task session, create and use a dedicated worktree on a `codex/` branch from `main`. Reuse that session's worktree on follow-ups; preserve other sessions' changes and `codex/legacy-nocheh`.
- Inspect the applicable specifications, current status, code, and acceptance procedure before editing. Use repository commands and pinned upstream dependencies; retain npm, TypeScript services, thin Python integration, React, and Docker Compose.
- Complete authorized work and continue independent work when a dependency is blocked. Do not ask for repeated permission for already authorized phase work.
- Keep credentials, source conversations, and runtime data out of commits and logs. A worktree does not isolate Compose resources or grant access to another installation's credentials or state.

</repository_workflow>

<verification>

- Retain existing tests and acceptance gates. No TDD mandate applies. Add focused behavior tests, including failure paths, for consequential changes to data preservation, privacy, provider handling, approvals, or recovery. Avoid low-value tests that mirror implementation or cover only reversible cosmetic edits.
- Run checks appropriate to the change. Documentation-only changes need link, structure, consistency, and coverage checks, not new automated tests or runtime startup.
- A phase is complete only when its documented acceptance criteria pass. Report skipped checks, missing credentials, and unrun live checks as pending, never as passes. Historical evidence is not a newly repeated check.
- Subscription transcription is a release requirement. If it fails, retain evidence and stop dependent release work while continuing independent work. The optional Honcho comparison does not block release; production Honcho activation has its own gates.
- Use local Docker Compose for runtime acceptance. Git integration does not authorize deployment, provider cutover, memory activation, release, or VPS work.

</verification>

<previews>

- For UI changes, run a preview from the session's worktree when a suitable environment exists. Use a dedicated localhost port and a persistent terminal. Capture that terminal session's ID and open that exact session with `mcp__codex_app__open_in_codex`; leave the process and its output visible.
- Open that preview URL with `mcp__codex_app__open_in_codex`. For visual and interaction verification, prefer `mcp__cua_repl.js` with the `iab` browser so the user and agent inspect the same preview.
- Before starting services, verify ownership of ports, Compose projects, networks, images, state, pollers, schedulers, and OAuth refresh. Do not start competing services against the active installation or borrow its login.
- Per-session preview isolation and the missing `make dev` recipe are follow-up work in `TASK.md`. Until implemented and verified, do not claim that command or a fresh worktree provides an isolated preview. The existing `./scripts/nocheh dev` targets the local installation; use it only in an explicitly assigned environment. If no suitable preview exists, report UI verification pending and continue independent work.

</previews>

<commits_and_integration>

- Make one commit per feature or distinct setup step. Do not combine unrelated features. Keep commits working and buildable whenever practical; a large phase may contain multiple separately verified increments.
- In each commit body, include a chronological bullet list of all relevant user prompts or excerpts. Keep them faithful, allowing up to about 10% editing to remove non-constructive wording or redundancies and resolve references using wording from earlier prompts. Keep entries self-contained; omit unrelated and automatically supplied context and never include secrets.
- After every verified increment, commit it, merge it into `main`, then push `origin/main`. Report the commit hash and continue automatically. Phase completion and runtime activation still require their separate acceptance evidence.
- Serialize integration through the shared Git directory returned by `git rev-parse --git-common-dir`: hold an exclusive OS advisory file lock (`fcntl.flock`, `LOCK_EX`) on `nocheh-integration.lock` there while checking main, merging, and pushing. All sessions use that same lock file; keep the file in place after releasing the lock. Fetch available remote changes, preserve unrelated work, reconcile concurrent commits, and rerun affected checks before integrating. Never reset another session's work or force-push main.
- If authentication or connectivity prevents fetch/push, a verified local integration may proceed when the main checkout is clean. Report local and remote outcomes separately, including the unpushed commit and exact blocker; do not claim synchronization succeeded.

</commits_and_integration>

<graphify>

Graphify is the repository's development code graph, not Nocheh's product memory.
When `graphify-out/graph.json` exists, use it for codebase questions, including when
its output is dirty. Query the existing graph before rebuilding it.

```sh
graphify query "How does incoming message processing work?" --budget 1200
graphify path "SOURCE" "DESTINATION"
graphify explain "CONCEPT"
npm run graphify:update
```

Use the Graphify skill's query expansion and source verification. Rebuild after
code changes with the AST-only workflow; keep Graphify out of runtime dependencies.
A documentation-only change does not require rebuilding the AST graph.

</graphify>

</agent_instructions>
