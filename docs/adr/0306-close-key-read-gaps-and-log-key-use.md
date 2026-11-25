# ADR-0306: Close the keys' read gaps and log each key's use

<status>
Accepted on 2026-11-25 as step 1, part C (first half), of the owner-approved key design. Builds on
[ADR-0305](0305-one-time-keys-per-reply.md) (one-time keys per reply) and
[ADR-0283](0283-machine-jobs-read-only-their-card.md) (machine jobs read only their card). The dashboard's Keys list and
"Stop everything now" are later work.
</status>

## Context

After ADR-0305 every pass is a one-time key with a row, but two read gaps were left and nothing recorded a key's use.

- **A machine job's memory search.** A run of a job on the owner's machine usually carries the owner's pass. Its archive
  reads keep to its card's chat, period and approval cutoff, but `NativeMemoryRepository.search` never looked at
  `machineReads`: it asked the memory engine across every session, with no wall, and counted every receipt as the owner's.
  Each hit was still checked by `canRead`, so no message leaked, but the engine saw the whole space, other chats' hits
  crowded out the card's, and `learned` was always true. ADR-0283 says the run searches only among its card's messages.
- **The broker's tool list for a machine run.** Machine runs only use the isolated runtime, whose `/mcp` the broker answers
  itself. The broker bound answer and member readers but never `bindMachine`, so a machine run was listed all the data tools,
  not its card's eight (ADR-0283 decision 6). Each call still met storage's machine route list, but a `shell` or `browser`
  call reached `/v1/tools/propose`, which is on that list, and a refused read route left proposed and allowed rows in the
  security log before storage refused it.
- **No record of use.** `assertOpen` only read the key's row. The security log named the agent of a broker effect, not its
  person or key.

## Decision

1. **A machine job's run searches only its card's chat.** In `search`, a reader with `machineReads` searches: a group card
   chat (or a topic of one) inside the wall of that group and its topics; the owner's chat among the owner audience's own
   sessions (and its topics'), with no wall; any other chat not at all (`{ids:[],learned:false}`), since a private chat is
   never learned. A hit counts only with a receipt of those audiences, never by the owner shortcut. The card's period and
   cutoff are still checked on each message found.
2. **The broker binds a machine run for `/mcp` and its relayed routes.** `BrokerStorage.bindMachine` (storage's
   `SourceAccessRepository.bindMachine`) binds the run's reads before `serveMcp`, which then lists and runs only
   `machineRunTools`. Before a relayed route is authorised, the broker refuses a machine run any route outside
   `machineRunRoute` (403 `machine_job_reads_card_only`), so it is neither relayed nor logged. The binding, guard, model and
   turn-file routes are not relayed routes and are unchanged.
3. **A machine run proposes only a Notion read.** `ControlledActionRepository.propose` refuses a reader with `machineReads`
   any proposal but an `mcp` call to the Notion connection (403 `machine_job_reads_card_only`); which pages it may read is
   checked as before. The `mcp` tool for outside MCP endpoints leaves `machineRunTools` and Hermes's `MACHINE_DATA_TOOLS`,
   so a machine run is offered seven tools, not eight.
4. **Review and filter keys stay as ADR-0305 left them.** Their routes reach no data tool and no read route, at storage and
   at the broker. `canRead` is not changed for them: their own binding, guard and model calls read their turn's source
   through it, so refusing them there would end every review and filter.
5. **Each request counts on its key's row.** `one_time_keys` gains `first_used_at`, `last_used_at` and `use_count`.
   `RuntimeTurnRepository.assertKey`, the first check of every request at storage and the broker, now runs
   `OneTimeKeyRepository.use`: one UPDATE that counts an open key matching the pass, or refuses as `assertOpen` does. Audience
   re-checks within a request do not count. A relayed request counts once at the broker and once in storage; a refused route
   counts too. The rows are swept with the keys after 30 days.
6. **The security log names the key.** `security_events` gains `person` and `key_id` (the jti). The broker's effects (relayed
   reads and model calls) carry them from the pass beside `agent`. No new rows are written; the pass itself is never stored.
7. **Pausing or removing a member closes their keys.** `Members.change` closes the member's open keys (`member_paused`)
   when it pauses them, and `Members.remove` (`member_removed`) in the same transaction (`closePerson`).

## Consequences

- A machine run's memory search costs the engine less and finds the card's chat's messages first.
- Every request with a key is one UPDATE instead of one SELECT at its first check.
- A paused member's reply or run under way stops reading at once.
- Still open: storage on 8780 takes keys directly as well as through the broker; requiring the broker in isolated mode needs
  a way to tell a relay from a direct call. The dashboard's Keys list and "Stop everything now" come next.
