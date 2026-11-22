<agent_instructions>

# Nocheh

<context>

Nocheh is a personal AI brain with Hermes as its first replaceable runtime, behind Nocheh's brain socket.
Nocheh's own `nocheh-telegram` service is the Telegram bot; the brain never holds the bot token.
Telegram is an adapter; owned source data, useful memory, and reasoning are the product.
Long-term memory is swappable too: it sits behind Nocheh's memory socket, and Honcho is the current engine.

- Read [SPECS.md](SPECS.md) for the authoritative product requirements and [TASK.md](TASK.md) for current implementation status, blockers, and evidence links. [Task history](docs/task-history.md) summarizes older records; the prior full ledger is in Git history. Specifications do not claim implementation or activation.
- Read the applicable code before relying on implementation descriptions. Plans under `docs/` provide execution order and acceptance procedures; [ADRs](docs/adr/README.md) explain decisions and their supersession history.
- When referring to memory, point out which memory is meant: Honcho memory, Hermes native memory, etc.
- This project is in development mode and has never been released. New changes do not need migrations or data ports for existing data.
- Follow explicit user instructions. Record new durable requirements in `SPECS.md` and new working instructions here. Do not infer product changes from incidental code behavior or historical plans.

</context>

<owner_questions>

- Whenever you ask the owner a question, keep it pending and wait for the owner's answer before ending the turn or assuming an answer. Continue only work that does not depend on that answer while waiting. Silence and elapsed time are not answers.

</owner_questions>

<specification_maintenance>

- `.md` files that AI writes and reads are plain-text context for AI, not documents that need one fixed format. Use XML for semantic structure and Markdown for content within that structure. Keep meaningful containers; avoid unnecessary leaf tags. Plain text can remain wherever neither adds clarity.
- `SPECS.md` is the durable definition of what Nocheh has to be and do. Collect every user prompt that counts as a spec there. Nest each area inside the area that contains it.
- A spec cannot stay verbatim when the prompt is a directive or request to change something. Convert it to spec-definition language, but keep the user's wording, do not paraphrase too much, and stay faithful to what they typed. Use the same wording fidelity for instructions the user asks to add here.
- Specs must be stateless and absolute: each spec defines the intended target independently of the implementation's current or previous state and remains meaningful as implementation changes.
- Do not preserve relative statements such as “the current size is right,” “keep it as is,” or “it remains unchanged” as specs. Convert them to explicit absolute requirements only when the intended requirement is known. Otherwise omit the uncertain wording and record the clarification needed in `TASK.md`.
- When adding or changing specs, audit related existing specs for state-dependent or ambiguous wording. Remove uncertain relative wording without silently removing an established requirement. Resolve ambiguity with the user; do not invent a replacement.
- Keep dates, commit hashes, progress, temporary failures, migration steps, and proposals in `TASK.md`, its linked task history, execution plans, or ADRs. Keep `TASK.md` focused on current status, blockers, next actions, and evidence links; summarize superseded dated reports in task history. Do not promote a proposal into the product definition without acceptance.
- After each completed task or verified increment, automatically reconcile `TASK.md` before committing: keep current implementation status, unresolved blockers, release gates, next actions, and concise evidence links there; fold completed dated reports into brief, chronological summaries in `docs/task-history.md`. Preserve full detail in Git history. Do this without a separate cleanup request, and never archive a pending gate as complete.
- Update specs with the feature, not as a later cleanup. Avoid duplicating product rules here or in active plans. Record new architectural decisions in new ADRs; preserve accepted historical ADRs unchanged.

</specification_maintenance>

<repository_workflow>

- Do each task on its own branch from `main` and open a pull request for it. Preserve other sessions' changes and the `archive/pre-hermes-nocheh` branch.
- Inspect the applicable specifications, current status, code, and acceptance procedure before editing. Use repository commands and pinned upstream dependencies; retain npm, TypeScript services, thin Python integration, React, and Docker Compose.
- Complete authorized work and continue independent work when a dependency is blocked. Do not ask for repeated permission for already authorized phase work.
- Keep credentials, source conversations, and runtime data out of commits and logs. A worktree does not isolate Compose resources or grant access to another installation's credentials or state.
- Git tracks source code, build and deployment configuration, documentation, and explicitly synthetic test fixtures. Keep runtime state, generated output, live acceptance reports, event and reply identifiers, source content, credentials, and installation metadata in ignored local state under `data/` or another ignored output directory. Before committing, scan staged files for private data and broken evidence links; never use a Git commit as the storage location for a live report. Tests, fixtures, previews, and examples use synthetic values; never copy a Telegram user, chat, group, topic, or message identifier or any other value from live state or a live link into them.
- In docs and commit messages, never point to the external example project by name or path. Remove any such references found in current files before committing.
- Don't name the owner's own provider gateway, hosting or devices anywhere in the repository: code, tests, docs, examples, and placeholders use neutral provider names, addresses and wording.
- The repository is public. Every push passes the privacy scan (`tools/development/privacy_scan.py`): run `git config core.hooksPath tools/development/git-hooks` once per checkout so it runs as a pre-push hook. It reads the owner's private word list from `NOCHEH_PRIVATE_TERMS_FILE` or `data/privacy-terms.txt`, which never enters Git, and refuses to run without it. Fix a refused push by rewording the files or commit messages, including earlier commits on the branch; never skip the hook.
- Keep project agent skills and supporting files only in `.agent/`. Discover the admin and deployment skills in `.agent/skills`. Do not add agent-specific support directories or compatibility skill links; `AGENTS.md` remains the root working-instructions file.
- Use `./bin/nocheh` for owner operations. Keep command routing in `tools/cli`, operational code in `tools/operations`, runtime helpers in `tools/runtime`, acceptance tools in `tools/acceptance`, development helpers in `tools/development`, and build helpers in `tools/build`. Keep the dashboard in `dashboard` and the Hermes plugin and Honcho service in `services`. Use absolute `tools.*` and `services.*` Python imports and the shared repository-root resolver.

</repository_workflow>

<verification>

- Retain existing tests and acceptance gates. No TDD mandate applies. Add focused behavior tests, including failure paths, for consequential changes to data preservation, privacy, provider handling, approvals, or recovery. Avoid low-value tests that mirror implementation or cover only reversible cosmetic edits.
- Run checks appropriate to the change. Documentation-only changes need link, structure, consistency, and coverage checks, not new automated tests or runtime startup.
- Do not run every real/live test after every change. Keep a record of completed checks and redo only the affected checks when needed. Before requesting owner traffic, inspect the acceptance register and saved receipts, record which change or failure invalidates the existing evidence, and use focused automated checks first. A new commit alone is not a reason to repeat live acceptance.
- Maintain the non-identifying live-test summary in `docs/mvp-acceptance-status.md` and the detailed evidence index in ignored `data/acceptance/results/mvp-live-test-register.json`. Preserve original outcomes, limitations, test dates, available runtime revisions/configuration, receipt references, and reasons for carrying a pass forward or requiring a rerun. Inspect an existing pending event before asking the owner to send another message.
- For owner-facing live acceptance, use ordinary conversational messages. Correlate test traffic by saved event IDs and timestamps rather than requiring an internal tool name or a test prefix in the owner's message.
- A phase is complete only when its documented acceptance criteria pass. Report skipped checks, missing credentials, and unrun live checks as pending, never as passes. Historical evidence is not a newly repeated check.
- Production Honcho activation has its own gates.
- Use local Docker Compose for runtime acceptance. Git integration does not authorize deployment, provider cutover, memory activation, release, or VPS work.

</verification>

<previews>

- For UI changes, run a preview from the task's checkout when a suitable environment exists, on a dedicated localhost port. Check the changed pages in a browser and share screenshots with the owner.
- Open that preview URL with `mcp__codex_app__open_in_codex`. For visual and interaction verification, prefer `mcp__cua_repl.js` with the `iab` browser so the user and agent inspect the same preview.
- Before starting services, verify ownership of ports, Compose projects, networks, images, state, pollers, and schedulers. Do not start competing services against the active installation or borrow its provider keys.
- Use `make dev` in the session worktree for the operating Compose project of its workspace (`nocheh` for `personal`) with source mounts on that workspace's localhost ports. Run one Compose stack per workspace and one poller per Telegram bot; stop the workspace's unattended services before starting development. Other workspaces may keep running (ADR-0245). A session worktree belongs to its main checkout's workspace: a `.env` a command writes there takes that workspace's name, and `./bin/nocheh test` there uses that workspace's images. Use the existing app service to watch and compile source; do not add a builder service. Verify pinned local runtime image revisions before using them as credential-free build bases. Keep the persistent terminal visible; use `make dev-status` and `make dev-stop` in that same worktree. Verify volume ownership, and a single Telegram poller before development. A clean setup creates new project-owned volumes; a normal restart retains them. An explicitly authorized data reset preserves credentials and settings when requested. Development startup does not replace local Compose release acceptance.

</previews>

<commits_and_integration>

- Make one commit per feature or distinct setup step. Do not combine unrelated features. Keep commits working and buildable whenever practical; a large phase may contain multiple separately verified increments.
- Write commit subjects as `type(scope): lowercase subject` with type `feat`, `fix`, `docs`, `chore`, `refactor` or `test`; omit the scope when the change spans several areas. Add a body only when the subject is not enough. Never quote the owner's private details in commits.
- Push the branch and open a pull request. The owner merges it, or a session merges it after the owner says yes. Phase completion and runtime activation still require their separate acceptance evidence.
- Before opening or updating a pull request, fetch `main`, preserve unrelated work, resolve conflicts by merging `main` into the branch, and rerun affected checks. Never reset another session's work or force-push `main`.
- If a push fails, report the unpushed commit and the exact blocker; do not claim it was pushed.

</commits_and_integration>

</agent_instructions>
