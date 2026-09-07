# ADR-0024: one editable environment configuration

Status: accepted. Date: 2026-09-07.

Use the ignored root `.env` for local Compose settings and internal credentials.
Provide a credential-free `.env.example` and an idempotent `init` command. Preserve
existing archive credentials when consolidating the earlier file-based settings.
An isolated state directory has its own `.env`; it never borrows the main login
or bot configuration. Only explicitly selected settings enter service containers.

Separate Compose secret files were an implementation choice. They avoid placing
values in container environment metadata, but ordinary local secret files do not
provide encryption at rest. The owner prefers environment configuration for this
local stack. Keep `.env` private and excluded from Git, images and diagnostic output.

Hermes retains its native OAuth file so its authentication implementation can
persist token refreshes. Production still uses only subscription authentication.
The optional experiment keeps its independently metered credentials separate.

Backup format 2 includes `.env`. Restores keep the saved settings as `restored.env`,
disable Telegram in the active `.env`, and hold OAuth inactive as before. Format 1
snapshots remain readable through the same one-time configuration conversion.
