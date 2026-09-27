# 0070 — Single agent support root

Status: Accepted

## Context

Project skills were canonical in `.agent/skills`, but duplicate links under `.agents/skills` and `.codex/skills` still made agent support appear to have several owners. The Graphify skill and a tool hook remained in `.codex/`, and a root `CLAUDE.md` link duplicated `AGENTS.md`.

## Decision

`.agent/` is the sole repository directory for agent support. Admin, deployment, and Graphify skills live in `.agent/skills`; supporting skill references stay with their skill. Root `AGENTS.md` remains the repository working-instructions file. Agent-specific compatibility links, directories, the old tool hook, and the `CLAUDE.md` link are removed. Graphify usage is specified in `AGENTS.md` and can still be run through the repository npm command.

## Consequences

Agents discover one shared set of project skills. Existing paths under `.agents/` and `.codex/` no longer resolve, and the removed tool hook no longer runs. Runtime behavior, owner commands, stored data, and deployment state do not change.

This decision extends [0069](0069-role-based-source-layout.md) on agent support placement. It does not change its tooling, service, dashboard, or launcher layout.
