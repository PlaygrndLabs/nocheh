---
name: nocheh-admin-cli
description: Inspect a Nocheh installation from the local read-only admin CLI, especially captured events, linked replies, workflow receipts, learned memory, approvals, and live acceptance evidence.
---

# Nocheh admin inspection

Use the installation checkout's `./bin/nocheh admin` for read-only owner
inspection. Read [the CLI guide](../../../docs/admin-cli.md) for command syntax.
Use `--json` when correlating records programmatically.

Start with metadata output. `--content` exposes original conversations and
agent replies; use it only when the task needs that content and keep it out of
commits, tool logs, and evidence files. Never print the installation token or
copy another installation's state into a worktree. A worktree without its own
configuration cannot inspect the operating installation by assumption.

For a live turn, start with its saved event ID and timestamp. Run
`./bin/nocheh admin trace EVENT_ID --json`, then `./bin/nocheh admin workflow WORKFLOW_ID
--json` for each relevant workflow. `events --after CURSOR`, `honcho`,
`learned`, `learning ID`, `reviews`, and `approvals` cover the other common
checks. The CLI rejects a running API revision that lacks event tracing rather
than treating an unfiltered result as evidence.

If no ID was supplied, use `trace latest --scope CONVERSATION_SCOPE --json`
when the scope is known. Confirm its returned ID and timestamp match the intended
owner interaction; other incoming traffic may be newer.

Compare the observations with [release acceptance](../../../docs/release-acceptance.md)
and [current status](../../../TASK.md). A receipt, healthy service, or CLI
response alone never passes a live gate. The CLI has no authority to send
Telegram traffic, approve actions, attach Honcho, or activate a candidate.
