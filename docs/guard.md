# Saved guarded copies

Set `NOCHEH_GUARD_MODE=on` (default) or `off` in the ignored `.env`, then
apply with `./scripts/nocheh up`. Existing `auto` values migrate to `on`.
Endpoint trust no longer changes this choice. ADR-0033 supersedes the older
outgoing-only policy; historical ADRs and compatibility reports remain unchanged.

Original messages and files are archived first. Durable jobs prepare each source
revision and save its guarded projection. UTF-8 text files and supported audio
produce separate derived artifacts with provenance. Unsupported media remains
available to the owner; agents cannot download original files while guarding is on.

The owner dashboard shows both versions, preparation status and revision history.
Saving or restoring creates a new guarded revision. Saved wording is authoritative,
including any text the owner deliberately leaves visible. Automatic jobs cannot
overwrite an owner revision. Conflicting saves return a conflict.

On selects current guarded copies for archive search, snippets, prompts, derived
text, learning and native context. Off selects originals with the same audience
permissions. A scoped broker checks the current context generation on every model
attempt. Previously prepared passages are reused; only new text needs detection.
Unknown, failed or unavailable content is withheld on. Retries and route changes
cannot bypass the broker. Agents have scoped credentials and no archive admin token.

The dedicated detector receives original text. Local code validates its literal
candidates and applies masks. Explicitly trusted transcription may receive original
media. Guarding does not encrypt the archive and detection can miss secrets.

Edits and mode changes retire runtime contexts and credentials. In-flight delivery
checks reject retired contexts. New native profiles preserve preferences, with
fresh MEMORY.md, USER.md and sessions; rebuilding memory is tracked in phase G6.
Preparing an import does not grant learning consent. Honcho activation and its live
provider checks are tracked separately in TASK.md.

Run `./scripts/nocheh test` for behavior checks. Synthetic acceptance covers exact
original bytes, restart/duplicate preparation, authoritative edits, current-only
retrieval, file restrictions, audience isolation and stale delivery rejection.
