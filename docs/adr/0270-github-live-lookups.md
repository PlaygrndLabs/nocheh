# ADR-0270: Live GitHub lookups

<status>
Accepted on 2026-11-21, as step 3 part 2 of the shared and private connectors plan.
The owner asked, on 2026-11-21, for "live lookups to repo if is need" in replies, besides
the code jobs of [ADR-0269](0269-github-per-project.md). Follows the Notion pattern of
[ADR-0268](0268-notion-per-project-or-person.md): a controlled `mcp` operation on a
connection the owner set up.
</status>

## Context

A code job copies a whole repository into a sealed box and waits for its card: right for
comparing tasks with the code, slow for "what changed in the app this week?". GitHub's
API answers such questions directly, and Nocheh's GitHub app can make a key that reads
only one repository's code.

## Decision

1. **A fixed few reads.** A lookup is a controlled `mcp` operation with
   `{connection:'github', tool, input}`. The tools are `search_code {repo, query}`,
   `read_file {repo, path, ref?}`, `list_files {repo, path?, ref?}`,
   `list_commits {repo, path?, since?, until?, ref?}` and `get_commit {repo, sha}`. Each
   input is checked (`src/github-arguments.ts`); anything else is 400
   `invalid_mcp_action`.
2. **Where.** A repository linked to a project is looked up in that project's groups
   and topics, and in the owner's private chat while the project is active. Any other
   repository is the owner's own, looked up only in the owner's private chat. Never in
   a job, a member's or stranger's private chat, or a group in no project (403
   `github_not_here`). Anyone who may talk in the group may ask, as for a project's
   Notion.
3. **No card.** Every lookup reads, so one asked where it may run, in a live turn, runs
   at once (authority `github_read:<project|own>`). A follow-up turn's lookup waits for
   the owner's card, as other operations do.
4. **Checked again right before it runs** (`githubRunRefusal`): not from a job, and still
   from where its repository may be looked up now.
5. **Running.** The executor's `github.lookup` asks GitHub for a key for that one
   repository, with Contents and Metadata read-only, and shapes a small answer: file
   paths, a file's text up to 60,000 characters, a folder's entries, commits with their
   messages, a commit's files with each change cut at 4,000 characters. The answer goes
   through the same secret check as every operation result. The app's key never leaves
   the executor's process.
6. **The tool.** Nocheh's MCP `github` tool has `operation=repos` (`GET /v1/github/repos`,
   the repositories usable in this chat) and `operation=call`.

## Consequences

- Issues and pull requests are not read: the app asks GitHub only for Contents and
  Metadata. Adding them would need the owner to accept new permissions on GitHub.
- GitHub's code search reads only a repository's default branch.
- Known gaps, accepted for now: members' private chats can't look up a project's
  repositories yet (step 5).
- Checks: `test/store-github-lookups.test.ts`, the MCP unit test, and the lookup tests
  in `services/hermes/test_github_connection.py`.
