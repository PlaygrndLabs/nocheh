<owner_operations>

# Sources, learned memory, projects and sharing

<status>
These routes use the three-store repository composition and have isolated HTTP
acceptance. The original-only application mounts these routes. Installation and full dashboard acceptance are tracked in
[TASK.md](../TASK.md); this document does not claim runtime activation.
</status>

<contract>
Owner authentication is required for every route below. Scoped assistant tokens
cannot mutate or inspect these owner surfaces. POST bodies reject unknown fields.
Mutations require the displayed expected revision and a stable `operation_id`;
retry the same operation unchanged after an uncertain response. A revision conflict
requires rereading the current record before preparing a new change. Original
source identifiers and links do not change when a derivative is activated.
</contract>

<routes>

| Method and route | Operation |
| --- | --- |
| GET `/v1/derivation-engines` | Installed engine names, versions and result kinds |
| GET `/v1/sources/:id/derivatives` | Version metadata, provenance, guarded readiness and active selection |
| POST `/v1/sources/:id/reprocess` | Queue work from a verified original file hash |
| POST `/v1/sources/:id/prepare` | Request deterministic preparation in the current authorization epoch |
| GET/POST `/v1/sources/:id/learning-consent` | Inspect effective learning permission or save an explicit owner decision |
| GET/POST `/v1/sources/:id/retirement` | Inspect a source's hidden state and history, or hide or unhide it; hiding cancels its pending replies |
| GET `/v1/reprocessing/:id` | Execution state and durable result reference |
| GET `/v1/derivatives/:id` | Exact saved output, producer/configuration/input provenance and guard link |
| POST `/v1/derivatives/:id/activate` | Activate a prepared version; `expected_revision: null` for the first selection |
| GET/POST `/v1/guards/:kind/:id` | Inspect or edit a representation; kind is events, artifacts or derived_artifacts |
| GET `/v1/guards/:kind/:id/history` | Immutable guard history |
| GET `/v1/guards/:kind/:id/revisions/:revision` | Inspect one prior guarded version |
| GET `/v1/learned` | Scope-filtered current interpretations, including retired entries |
| GET `/v1/learned/:id` | Active pointer and bounded version history |
| GET `/v1/learned/:id/history` | Prior text, evidence, uncertainty, conflicts and provenance |
| POST `/v1/learned/:id/correct` | Owner correction or retirement with an expected revision |
| GET/POST `/v1/projects` | List, with each project's served `groups`, or create/edit/archive a project |
| GET/POST `/v1/projects/assignments` | A group's project, or none; a topic only follows its group |
| POST `/v1/chats/state` | Turn Nocheh on or off in a group it is in, at once and as one owner command: `chat_id`, `state` (`active` or `off`), `operation_id`, and, only when turning it on, an optional `project` (`{"mode":"new"}` for a new project named after the group, `{"mode":"assigned","project_id":…}` or `{"mode":"none"}`); answers `chat_id`, `state` and `project_id`; 400 `chat_not_group`, 404 `chat_not_found`, 409 `chat_not_joined` for a group Nocheh left, was removed from or knows only from imported history ([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)) |
| GET/POST `/v1/members` | GET: the member `revision`, the daily message cap (`daily_messages`), every group Nocheh is in (`groups`), each member (`id`, `account_id`, `state`, names, `owner_linked` when the account is the owner's own and so counts for nothing, `permissions` `{talk, jobs, post, tools, tasks}`, and `groups`, each with `on`, `telegram` (`in`, `left` or null) and `new`), and `people`: those seen 'in' in those groups who are not members, never the owner, a bot or a proxy account. POST adds a member: `operation_id`, exactly one of `account_id` (a person Nocheh has seen) or `telegram_id` (Add by Telegram user ID, whose account is made when missing), and `groups`, group chat ids each set to true or false, at least one true (400 `member_group_required`); true writes a switched-on row and false a switched-off one, and a group left out gets none, so it counts as on. With `account_id`, each true group needs Telegram's newest row for them there to say 'in' (409 `member_group_not_seen`); with `telegram_id`, any group Nocheh is in may be true. Also 404 `member_account_not_found`, 400 `member_account_invalid` (the owner, a bot or a proxy account), 400 `member_group_invalid` (a group Nocheh is not in) and 409 `member_exists`; answers `revision` and `member` ([ADR-0259](adr/0259-members-in-groups.md)) |
| POST `/v1/members/:id` | Change a member: `operation_id` and `changes`, with any of `state` (`active` or `paused`), `talk`, `jobs`, `post`, `tools`, `tasks` (`write` or `read`) and `groups` (true or false per group). False works for any group Nocheh is in; true switches an existing row on, or makes one only where Telegram's newest row says 'in' (409 `member_group_not_seen`); 400 `member_change_empty`, 404 `member_not_found`; answers `revision` and `member` |
| POST `/v1/members/:id/remove` | Remove a member with `operation_id`: its switches and daily counts go and its accounts are unlinked; Telegram's membership rows stay; answers `revision` and `removed`; 404 `member_not_found` |
| POST `/v1/members/settings` | The daily message cap: `operation_id` and `daily_messages`, a whole number from 1 to 10,000 (400 `invalid_daily_messages`); answers `revision` and `daily_messages` |
| GET `/v1/telegram/identities` | The groups Telegram has shown Nocheh with their Telegram ids and the people in each, by name, and `truncated`; each group Nocheh is in also lists every member account switched on there (`member: true`), seen there or not, so the management side can ask Telegram for those members' names (`getChatMember`); a switch that is off lists neither the group nor the person |
| POST `/v1/telegram/chats/refresh` | Ask Telegram for the current names of up to 50 groups Nocheh is on in, those never refreshed first, then those refreshed longest ago, ties by id; sends nothing to a chat and never changes whether a group is on, though an upgraded group gets its new id at once; answers `chats` (one row per Telegram id asked, so an upgraded group answers twice) and `remaining`, the groups not asked that were not refreshed in the last hour, counted once each; 503 `telegram_refresh_unavailable` when Telegram cannot be asked ([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)) |
| GET `/v1/projects/effective?space=…` | Effective membership, with inheritance shown |
| GET/POST `/v1/sharing/rules` | Selected source spaces, exact destination, mode and enabled state |
| POST `/v1/sharing/preview`; GET `/v1/sharing/previews[/:id]`; POST `/v1/sharing/previews/:id/approve` | Prepare, inspect or approve a release from chosen sources |
| GET `/v1/sharing/releases`; POST `/v1/sharing/releases/:id/revoke` | List or revoke releases |
| POST `/v1/memory/provenance` | Bounded Honcho conclusion ancestry, each conclusion's exact cited messages or derivation batch, and confirmed ingestion references |
| GET `/v1/private-answers` | The record of Answer privately buttons, newest first, 100 a page: who asked, where, the project, the groups frozen at the tap, the state and its times; `project` keeps one project and `after` continues from an answer's id ([ADR-0249](adr/0249-answer-privately.md)) |

Chat and topic values in these routes (`space`, `space_id`, `scope_id`, a rule's
`sources` and `destination`) are Nocheh chat ids ([ADR-0252](adr/0252-chats-get-nochehs-own-ids.md)).
They are opaque: a chat Nocheh knew before step 2b keeps the value it was stored
under, and a chat or topic first seen later has a 64-character digest id. Never
build or parse one; find a chat in GET `/v1/conversations`, whose `q` matches a
chat's id, its name, its group's name and every Telegram ID it has had, current
or old (a topic has its group's), and whose items carry `kind`, `parent_space`, `topic_key`,
`app_ids` (each app id with `current` or `old`, so an upgraded group lists both),
`is_forum`, `state` and `owner`. Optional `kind` (`private`, `group` or `topic`)
and `state` (any chat state; a topic is in its group's) keep only matching
chats. They apply with `q` before paging, so a page and its `next_cursor` hold
only matches; a bad value is refused with `invalid_conversation_kind` or
`invalid_conversation_state`. `/v1/owner/conversations` takes them too
([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)). Only a group the chat
directory knows, or one of its topics, joins a project or shares; any other id
counts as a private chat.

List cursors use `after`; histories use `before`. Learned filters use both
`scope_kind=conversation|project` and `scope_id`. Sharing rules configure preparation;
they never grant direct reads of another conversation. Provenance lists the
messages each Honcho conclusion cites, first and in citation order, and marks each
conclusion's `exact_citations`: true for its cited messages, false when it has no
citations and brings its whole derivation batch, null when it brings none. The
answer is exact only when some conclusion is true and none is false; a false one
adds `ancestry_is_not_an_exact_citation` to its limitations. Missing provenance is reported explicitly.

Learning consent uses `enabled`, `expected_revision` (zero for the first explicit
decision), and `operation_id`. A successful change revokes previous contexts and
queues memory refresh in the same control transaction. Imported sources do not
gain learning permission merely by being imported. This permission cannot cause
old Telegram messages to be answered or authorize an external action.
</routes>

<cli>
`./bin/nocheh sources --help`, `projects --help`, `learned --help`, and
`sharing --help` describe the equivalent owner commands. They resolve the saved
local API configuration without running setup or activating services.

- `sources versions EVENT_ID`, `sources derivative DERIVATIVE_ID`, and
  `sources job JOB_ID` inspect records.
- `sources learning-consent EVENT_ID` inspects permission. `sources set-learning
  EVENT_ID --enabled true|false --revision N --operation-id REQUEST_ID` grants or
  revokes learning for that source.
- `sources reprocess EVENT_ID --artifact FILE_ID --input-hash SHA256 --engine NAME
  --version VERSION --operation-id REQUEST_ID` queues a version; optional
  `--configuration FILE` supplies engine configuration.
- `sources activate DERIVATIVE_ID --revision N --operation-id REQUEST_ID` selects
  a prepared result; zero denotes no prior selection.
- `sources guard KIND ID`, `sources guard-history KIND ID`, `sources edit-guard ID
  --kind KIND --file JSON_FILE --revision N --operation-id REQUEST_ID`, and
  `sources restore-guard ID --kind KIND --from-revision N --revision CURRENT
  --operation-id REQUEST_ID` inspect and preserve guarded history.
- `learned list --scope-kind conversation --scope-id CHAT_OR_TOPIC`, `learned show
  ID`, and `learned history ID` inspect projections. `learned correct ID
  --text-file FILE --revision N --operation-id REQUEST_ID` and `learned retire ID
  --revision N --operation-id REQUEST_ID` create authoritative owner revisions.
- `projects list`, `projects assignments`, and `projects effective --space SPACE`
  inspect membership. `projects save --file REQUEST_JSON`, `projects assign --file
  REQUEST_JSON`, and `sharing save --file REQUEST_JSON` send exact revisioned bodies.
  Archiving sets a project's state to `archived`; revocation disables the sharing rule.

Project save fields: optional existing `id`, `name`, `description`, `state`,
`expected_revision` (zero for create), `operation_id`. Assignment fields:
`space_id`, `mode` (`assigned`, `none`, or `inherit`), optional `project_id`,
`expected_revision`, `operation_id`; a topic takes only `inherit`, and any other
mode is refused with 400 `project_topic_follows_group`. Any other field, such as
the removed `sharing_enabled`, `sharing_mode` or `share_into`, is refused with
400 `unknown_policy_field`. Sharing fields: optional existing `id`, `name`,
`sources`, `destination`, `enabled`, `mode` (`approved` or `filtered`),
`instructions`, `expected_revision`, `operation_id`.

A project shares no knowledge between its groups: a group answer uses only that
group ([ADR-0247](adr/0247-projects-replace-the-share-box.md)); its groups share
only the tasks set on the whole project
([ADR-0248](adr/0248-tasks-follow-data-access.md)). Every sharing rule is
the owner's own. A rule with more than 100 sources is refused with 400
`invalid_sharing_sources`, and a change that would give a group more than ten
enabled filtered rules, counted over its General chat and topics, is refused
with 409 `sharing_rule_limit`. A knowledge proposal read by the owner lists in
`project_groups` each project its change moves a group into or out of, with the
other served groups there; a project the proposal creates and puts a group in
is listed with the id `new:<key>` and no groups. An applied organization lists
in `undo_project_groups` the projects its undo touches.
</cli>

</owner_operations>
