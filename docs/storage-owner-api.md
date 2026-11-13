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
| GET `/v1/projects/effective?space=…` | Effective membership, with inheritance shown |
| GET/POST `/v1/sharing/rules` | Selected source spaces, exact destination, mode and enabled state |
| POST `/v1/sharing/preview`; GET `/v1/sharing/previews[/:id]`; POST `/v1/sharing/previews/:id/approve` | Prepare, inspect or approve a release from chosen sources |
| GET `/v1/sharing/releases`; POST `/v1/sharing/releases/:id/revoke` | List or revoke releases |
| POST `/v1/memory/provenance` | Bounded Honcho conclusion ancestry, each conclusion's exact cited messages or derivation batch, and confirmed ingestion references |

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

A project shares nothing between its groups: a group answer uses only that group
([ADR-0246](adr/0246-projects-replace-the-share-box.md)). Every sharing rule is
the owner's own. A change that would give a rule more than 100 sources, or a
group more than ten enabled filtered rules, is refused with 409
`sharing_rule_limit`. A knowledge proposal read by the owner lists in
`project_groups` each project its change moves a group into or out of, with the
other served groups there, and an applied organization lists in
`undo_project_groups` those its undo touches.
</cli>

</owner_operations>
