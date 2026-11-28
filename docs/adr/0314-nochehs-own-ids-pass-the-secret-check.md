# ADR-0314: Nocheh's own ids pass the secret check

<status>
Accepted on 2026-11-28, after a live test in the owner's private chat: the tasks tool showed every task id as `***`, so
the agent could not update the task it had just added (`invalid_task_id`). Amends the runtime context preparation of
ADR-0138 and ADR-0251; keeps secret masking on.
</status>

## Context

- Hermes hands every tool result to the model through `/v1/context/prepare`, which runs the secret check on its text.
- Nocheh's record ids are 64 lowercase hex characters. To the secret-check model such a string looks like a key, so it
  hides it. A hidden id cannot be named in the agent's next call.
- Values a route marks prepared for a turn's audience pass the check unchanged (`PreparedContextRepository.allow`), as
  search results already do.

## Decision

1. `ownIds` (`src/stores/prepared-context.ts`) finds Nocheh's own ids in an answer of its own routes: a whole 64-hex
   string value under the key `id`, a key ending in `_id` or `_ids`, or one of `parent`, `scope`, `project`, `group`,
   `task`, `event`, `source`, `source_event`, `repeated_to`, `repeated_from`. It never looks into `properties` (task
   properties the owner named) or `external` (other apps' ids), and never into free text.
2. `allowIds` marks those ids prepared for the turn's audience before the answer is sent: the task routes
   (`/v1/owner/tasks…`), the owner's views (`/v1/owner/…`), every answer sent through `result()` (jobs, proposals,
   message requests, actions) and the knowledge context.
3. Everything else in the answer is still checked when the agent hands it to the model. A secret in a title, and a 64-hex
   value in notes or a property, are still hidden.

## Consequences

- The agent sees and reuses task, project, job and proposal ids; the model's next call keeps them whole.
- Each id is its own prepared segment, so the rest of the text reaches the secret check as several fragments of one call.
- Another audience (another chat, or another purpose) does not inherit the ids; its own route answers mark them.
- A route not listed in decision 2 still has its ids hidden if the check flags them; add `allowIds` there when needed.
