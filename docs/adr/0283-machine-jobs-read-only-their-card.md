# ADR-0283: A machine job reads only what its card shows

<status>
Accepted on 2026-11-23. The owner approved this fix in the November security review
(machine jobs' reads limited to the card's chat, period and named Notion pages, frozen at
approval, not removed). Amends [ADR-0231](0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md)
("The run": the archive tools and Notion) and, for machine jobs only,
[ADR-0225](0225-member-safety-rules.md) (Notion reads in jobs).
</status>

## Context

A machine job has its own network. Under ADR-0231 its run kept every archive tool, memory
recall and the owner's Notion, so text it read on the machine could ask it to search
other chats and send what it found out. The card named the chat and period, but the
pass allowed more.

## Decision

1. **Bound on the server.** For a run whose turn belongs to an approved machine job,
   storage sets `machineReads` itself from the job row (`bindMachine`): the job's chat,
   its card's period, the archive's last capture sequence at Approve
   (`background_jobs.reads_until`) and the Notion pages its card names
   (`background_jobs.notion_pages`). A pass that carries `machine_reads` is refused
   (`invalid_scope_token`).
2. **Archive reads.** `canRead` and `readable` refuse any source outside that chat, outside
   that period, or captured after Approve, for the owner's own jobs too. Search, pages and
   recall narrow to the chat; a page of another chat is `conversation_not_permitted`.
3. **Routes.** A machine run reaches only archive reads, memory search, long-term context
   and recall (answered as limited), its own action requests and tool proposals, Notion
   connections and its machine commands (`machineRunRoute`); anything else is
   `machine_job_reads_card_only`. `/v1/memory/context` gives it nothing.
4. **Notion.** A machine job reads no Notion unless its proposal names 1 to 5 pages
   (`notion_pages`, raw id or notion.so address) and the owner's Notion reads without
   asking; otherwise `job_notion_not_allowed`. Its run may list tools and fetch only those
   pages (`notion_page_not_on_card`); no search. Changes still ask. The pages are part of
   the fingerprint.
5. **Card.** The size line reads "Reads only {place}: {size}. Nothing sent after you approve
   reaches it, and it cannot search your other chats or memory." Named pages show as "It can
   read only these Notion pages without asking: {pages}." Both are editable
   `background.texts` lines.
6. **Tools.** Hermes offers a machine run only the archive, memory search, action, MCP,
   Notion and status tools from Nocheh (`MACHINE_DATA_TOOLS`); the MCP server offers the
   same list (`machineRunTools`). Owner views, tasks, knowledge, GitHub, Gmail, member asks
   and destinations are gone.

## Consequences

- One Approve no longer opens the owner's other chats, memory or Notion to whatever the
  machine shows the job.
- A job cannot read a message sent after Approve, even in its own chat. The owner asks
  again for newer messages.
- The run text says the archive tools are limited, so the agent does not try other chats.
- Checks: `test/store-machines.test.ts`, `test/machine-reads.test.ts`,
  `test/prompts.test.ts`, `services/hermes/test_scopes.py`,
  `services/hermes/test_machine_box.py`.
