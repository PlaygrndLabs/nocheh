# ADR-0029: Execute broader tools outside the credentialed agent

Status: accepted and verified for the bounded P5 capability under ADR-0027. Date: 2026-09-08.

The native agent may propose shell, browser and MCP operations. It cannot execute
arbitrary code in its own process, which carries subscription and archive access.
Each proposal records immutable arguments, source event, profile and scope. The
owner reviews the exact operation in Nocheh or their private Telegram conversation.
Standing permissions match that exact operation in that profile and scope, expire,
have a maximum number of uses, and can be revoked before another execution starts.

An independent host supervisor claims approved work from PostgreSQL. Shell commands
run in disposable containers with only the selected workspace mounted, no network,
no credentials, no Docker socket, a read-only root and bounded resources. The host
supervisor never interprets an agent-supplied command itself. Remote operations use
an explicit HTTPS broker: public destination addresses only, pinned DNS resolution,
no redirects, no ambient cookies or credentials and bounded responses. Browser page
inspection renders that approved response in an offline browser; page scripts and
secondary network requests cannot expand the approved operation. MCP supports
bounded HTTP JSON-RPC tool calls; server requests for sampling, roots or elicitation
cannot execute local capabilities. Broader interactive browsing and arbitrary local
MCP processes are outside this initial capability.

Claims never automatically retry external work after an uncertain outcome. A saved
receipt can be reconciled, but missing receipts remain ambiguous. Revocation blocks
new claims; it cannot undo a remote request already sent. Generated results and
decision evidence retain provenance alongside the unchanged source originals.

MCP uses the [2025-11-25 transport contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). JSON responses only are supported; server-sent events and interactive authentication remain unavailable.

Verification: [content-free local acceptance](../../compatibility/results/2026-09-08-controlled-tools.json). Backup drains the executor and includes its pending receipts. Restored executors remain inactive.
