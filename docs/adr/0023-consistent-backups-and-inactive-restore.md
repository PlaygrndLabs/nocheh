# ADR-0023: consistent backups and inactive restore

Status: accepted; local backup/restore rehearsal verified.
Date: 2026-09-07.

Take a quiesced snapshot of PostgreSQL, original files, durable journals and native
Hermes state. Stop ingress before writers. Retain checksums and table fingerprints
so a restore can verify original content, derived artifacts and execution state.

Restore into a new Compose project and directory. Keep the restored Telegram
policy disabled and hold the saved OAuth file outside its active path. This allows
verification without starting a duplicate bot or refresh owner. Prefer a fresh
dedicated login when activating a recovered environment.

For a planned cutover, keep source writers stopped after their final snapshot.
An older backup cannot establish whether pending actions were delivered after the
snapshot; the owner must reconcile that gap before activation. This differs from
ordinary restart recovery, which has current durable delivery receipts. The
rebuild still cannot merge until actual Telegram acceptance passes.

See [local operations](../deploy.md).
