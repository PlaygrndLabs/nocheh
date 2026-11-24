# ADR-0301: One-time keys per reply

<status>
Accepted on 2026-11-24 as step 1, part B, of the owner-approved key design (design decisions 2 and 3). Builds on
[ADR-0295](0295-agent-login-replaces-the-master-key-in-hermes.md) (the agent login) and
[ADR-0290](0290-nocheh-grants-schedule-changes-and-fires.md) (Nocheh grants every schedule change and fire).
Closing read holes, a log of each key's use, the dashboard's Keys list and "Stop everything now" are later work.
</status>

## Context

A pass was a signed claim set: a chat, a binding and a few claims (member, lane, answer, member_read, purpose, app). It
named no person, its `agent` claim was checked for shape only, and nothing on the server knew it existed: a copy of a
pass worked until it expired (ten minutes for a reply, up to an hour for a background job's run), also after its reply
had gone out or its run had ended. Hermes saved the pass of each reply in its spool, so a restart could relaunch with
one read from disk. The archive-wide `scope.` pass had no caller left. A memory review's and a sharing filter's pass read
as the owner in storage; only Hermes withheld their data tools.

## Decision

1. **Every pass is a one-time key.** A pass is today's pass plus `person` (`'owner'` or a `members.id`), `jti` (its own
   id, 32 random hex), `key_kind` and `agent`, which must be the agent plugged in now (`activeAgent`). The kinds are
   `turn` (a reply), `follow_up` (the answer after operations end), `member_ask` (the owner's ask about a member),
   `scheduled`, `background`, `review` and `filter`. A pass carries no read set: what it reads is worked out on the
   server for every request, as before. `scope.` passes and `scopeToken` are gone, and the verifier refuses a pass
   without these claims (401 `invalid_scope_token`).
2. **The person fits the pass, and somebody must be named.** A member's own private chat is that member's; a group or
   topic message is its sender's (the owner, or a member while they are one); the owner's chat, an answer, an ask, a
   review and a filter are the owner's; a lane is always its person's. A follow-up is for the person whose turn asked
   for its leader operation; a scheduled run is for the schedule's creator (or, with none recorded, the owner in the
   owner's chat and the member in their own chat); a background job's run is for the job's requester. The verifier and
   `AudienceRepository.turn` both check this; when nobody can be named no pass is minted (409
   `one_time_key_person_required`), a person or kind that does not fit the pass is refused (409
   `one_time_key_person_mismatch`, `one_time_key_kind_mismatch`), and a reply or follow-up whose sender stopped being a
   member is withdrawn.
3. **Each key has a row.** `one_time_keys` (jti, kind, subject, attempt, person, agent, event_id, created, expires,
   closed_at, closed_reason) gets one row per reply or run attempt, keyed by (kind, subject, attempt): every pass signed
   again for the same attempt (each presence renewal, the delivery) carries the same jti, so closing the row ends the
   agent's copy, the bot's copy and the delivery copy at once. A closed or expired row is never opened again (409
   `one_time_key_closed`), nor opened for another person, agent or event (409 `one_time_key_conflict`). A review's and a
   filter's attempt carry a fresh random part, since each call is its own key. Rows stay 30 days after they close or
   expire, for the Keys list; they hold no secret.
4. **Every request checks the key.** Storage and the security broker check the row before anything else is done for a
   pass (missing or not matching: 401 `one_time_key_unknown`; closed or expired: 409 `one_time_key_closed`, which the
   agent takes as final). Every audience check of a reader made from a pass checks it again, so the broker's model
   stream, storage reads and `turns.binding` fail once a key closes mid-turn. Readers Nocheh builds itself have no key.
5. **Keys close when their work is done.** A reply's key closes when its dispatch row reaches an end state (delivered, or
   not), which nocheh-telegram's receipt now only allows after the delivery check, presence and final reaction; a
   follow-up's and an ask's likewise. A scheduled or background run's key closes in the transaction that ends, cancels or
   interrupts the run, also when its schedule's execution version changes or the owner cancels it. A browser run (the
   dashboard chat's machinery, whose routes stay off) is the owner's and has a turn key, closed the same way; Hermes
   takes no key for that channel, so it runs none. A review's
   key closes once the review is no longer running, a filter's as soon as its call returns.
6. **Each kind reaches only its routes.** Turn, follow-up, scheduled and background keys reach the broker's relay routes
   and the turn's own binding, files, box copy, `/mcp`, guard, model and conversation-report routes; an ask's key keeps
   its read list; a review's key reaches the delivery check, its binding, context preparation, guard and model calls; a
   filter's key its binding, guard and model calls. Everything else is 403 `one_time_key_route_denied`, in storage and
   the broker alike (`src/stores/key-routes.ts`). Bound readers keep their read-only codes and machine runs theirs.
7. **Runs and cards remember who and which agent.** `managed_runs`, `controlled_actions`, `telegram_action_requests` and
   `background_jobs` keep `person` and `agent` when made from a key, and `workflow_schedules` keeps `agent` beside its
   `created_by`. A run is claimed only with a person (409 `one_time_key_person_required`) and for its own agent (409
   `one_time_key_agent_changed`), and `turns.binding` refuses a key for another person or agent (409
   `one_time_key_person_changed`). An operation or a send made for another agent never runs; the owner's own Gmail,
   Notion and repositories refuse a row made for a member's key.
8. **No pass on disk.** Hermes no longer writes a reply's pass into its spool's request file, and a resume that would
   launch needs a fresh pass from Nocheh.

## Consequences

- A copy of a pass is worth nothing once its reply is delivered or its run ends, and a review or filter pass reaches no
  data tool even if Hermes's own check were bypassed.
- A broker built without storage (unit tests only) checks no key; production always passes storage.
- A presence reaction that lapses after its key closed is refused: cosmetic, and fails closed.
- Rows made by Nocheh without a key (system sends, internal readers in tests) keep a null person and agent and are not
  refused for it.
- Every request with a pass costs one more indexed read of `one_time_keys`.
