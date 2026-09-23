# Nocheh implementation status

<evidence_graph_collection>

#### Private knowledge graph root type — 2026-09-23

The owner noticed that the `All private knowledge` node was shown as `Group`.
Both graph endpoints had created the aggregate `*` root with a `group` kind,
causing the dashboard's browser, inspector, legend, and type filter to treat a
navigation container as a Telegram group. The aggregate root is now a distinct
`Collection` node with ID `collection:*`; scoped conversations keep their
existing group identities and private-chat presentation. The CLI graph adapter
also normalizes older `scope:*` and `group:*` roots to this collection type.

The pinned Node 24 Docker build passed. All 23 dashboard checks passed, as did
the legacy PostgreSQL graph test and the separated-store retrieval test against
separate isolated synthetic databases. An isolated preview on port 18947 visibly
shows `COLLECTION · All private knowledge`; its private-chat filter shows only
the actual direct conversation. The worktree's AST-only Graphify refresh covers
526 files, 3,579 nodes, and 13,348 edges with zero model calls. The active
installation was not rebuilt or activated; its dashboard will show the old type
until a separately authorized local rebuild.

</evidence_graph_collection>

<mvp_readiness_recheck>

#### Fresh local MVP readiness test — 2026-09-23

The owner requested a real test of MVP readiness. Read-only diagnostics of the
running local installation found all 17 required services healthy and no workflow,
worker, tool, scheduler, or subscription-login execution holds. A fresh reset
preflight found 17 owned containers, three mounted volumes, 55 classified paths,
zero ownership blockers, and ten pending reset phases. The saved storage layout
remains `legacy`; this preflight neither authorized nor executed a reset.

The live shared-subscription probe passed refresh, literal detection, and Ogg/Opus
transcription. Its exact-chat probe timed out after 129 seconds, so that complete
run failed. One focused exact-chat retry then passed in 8.4 seconds. Both outcomes
are retained; the retry does not erase the timeout. The isolated
`./scripts/nocheh test` gate passed on the pinned images: 126 Node/dashboard
checks passed with 46 fixture skips, the separate database-loss recovery check
passed, and 353 native Hermes tests passed with three skips. Its temporary
Compose containers, networks, and database volume were removed. The active
installation still had all 17 required services healthy afterward.

MVP release acceptance remains **not established**. The controlled
legacy-to-original-only transition, fresh backlog boundary and empty-baseline
proof, row-linked post-boundary Telegram checks (owner voice, designated group
with a non-owner human reply and reaction, intentional silence, private/group
isolation, exact approval, and restart receipt recovery), and separate Honcho
production acceptance are pending. No reset, live Telegram test send, approval,
provider cutover, or Honcho activation was performed in this recheck.
[Content-free results](compatibility/results/2026-09-23-mvp-readiness-recheck.json).

#### Current-revision follow-up — 2026-09-23

At `e441630`, a second read-only local diagnostic found all 17 required services
running and healthy, no execution holds, Telegram connected, guard mode on, and
CLIProxy as the shared provider's sole refresh owner. A new live synthetic
subscription run passed refresh (8 ms), exact chat (7.1 s), literal detection
(3.2 s), and Ogg/Opus transcription (4.6 s). The earlier 129-second exact-chat
timeout remains recorded above as a separate reliability observation.

The current-revision isolated `./scripts/nocheh test` gate passed 126
Node/dashboard checks with 46 fixture skips, the database-loss recovery check,
and 353 native Hermes tests with three skips. Its temporary Compose project and
volume were removed; the active installation remained 17/17 healthy. A fresh
read-only reset preflight found the `legacy` layout, 17 containers, three volumes,
55 classified paths, zero ownership blockers, and ten pending phases. The
five external archive review roots contain no immediate items. This inventory
did not authorize or execute a reset.

MVP release acceptance is **not established**. The controlled reset, fresh
post-boundary Telegram and group/human evidence, exact owner approval and restart
receipt checks, and post-reset Honcho production acceptance remain pending.
No installation reset, test message, approval, or external delivery occurred in
this follow-up. [Content-free results](compatibility/results/2026-09-23-mvp-real-test-current-revision.json).

#### Fresh live probe and reset inventory — 2026-09-23

At `ba83a99`, a read-only diagnostic again found all 17 required local Compose
services running, Telegram connected, one shared-provider login, guard mode on,
and no execution holds. A fresh synthetic live probe passed refresh, exact chat,
literal detection, and Ogg/Opus transcription. The source code is unchanged
since the isolated suite at `e441630`; only this status record and its evidence
file followed that tested revision. The earlier 129-second chat timeout remains
a separate reliability observation.

A fresh read-only reset inventory found the legacy layout, 17 owned containers,
three volumes, 55 classified paths, zero ownership blockers, and ten pending
phases. Five external archive review roots now contain 16 immediate items; their
exact ownership has not been classified. The preflight is not executable and no
installation reset was performed. The current dashboard/database-browser source
has not been activated in the local installation. Post-reset Telegram, group and
human, exact approval, restart receipt, and Honcho production acceptance remain
pending. MVP release acceptance is **not established**.
[Content-free results](compatibility/results/2026-09-23-mvp-readiness-live-probe.json).

#### Local app and dashboard rebuild — 2026-09-23

The owner requested a rebuild of the app. From clean local `main` at `049ba39`,
the active installation's `nocheh-app` and `nocheh-dashboard` images were rebuilt
and only those two containers were recreated. Compose ownership inspection found
the expected `nocheh` project, exact installation root and state anchors, and
zero foreign-writer blockers before the rebuild. Both recreated containers run
their new image IDs and report healthy. All 17 required services remain running;
the app and dashboard local endpoints return HTTP 200, Hermes reports Telegram
connected, and no execution holds are present. No database, provider, Honcho,
executor, or Hermes container was recreated. This activates the current app and
dashboard code locally but does not establish the pending reset, fresh Telegram,
or Honcho MVP release gates.
[Content-free result](compatibility/results/2026-09-23-app-dashboard-rebuild.json).

#### Live post-rebuild Telegram test — 2026-09-23

The owner sent one synthetic DM and confirmed exactly one appropriate Telegram
reply. The active local installation captured it once, finished dispatch on its
first attempt, recorded one delivered `sendMessage`, and displayed the reply in
the rebuilt dashboard Archive. Capture-to-delivery was about 30 seconds.

The owner also sent a synthetic voice note. The captured audio file exists and
matches its stored byte count and SHA-256. Subscription transcription completed
on its first attempt with matching input provenance. The transcript recognized
the synthetic acceptance phrase, though it rendered the bot name differently.
The assistant result links to the voice event, dispatch completed on its first
attempt, and one `sendMessage` delivery was recorded about 46 seconds after
capture. The owner reported a reply, but its harmless synthetic marker was
replaced by `***`. The original transcript retains the marker while its automatic
guarded projection masks it. This is a live answer-quality finding; the voice
answer is not a clean semantic pass.

The selected group's exact synthetic logging-only message was captured once and
suppressed after one attempt with `intentional_silence`. No outbound intent,
result, or delivered message appeared in that group's test window. The owner
confirmed no Telegram-visible reply.

For private/group isolation, the owner's private marker and group question were
captured in separate scopes and in order. The group policy has no access to the
private DM source, no active share grants it, and neither the group's prepared
context nor its derived inputs contained the marker. The delivered group reply
did not contain the marker; the owner observed a refusal to access the DM.
It cited the group's own question using an internal event ID, which the owner
found unclear. Group capture-to-delivery took about 125 seconds, a live latency
concern for the MVP's fast-answer goal.

These are **pre-reset** observations on the `legacy` layout. Private/group
isolation passed as observed, while exact owner approval, restart receipt recovery, the
post-reset human group reply/reaction, and post-reset Honcho production acceptance
remain pending. MVP release acceptance is **not established**.
[Content-free result](compatibility/results/2026-09-23-post-rebuild-live-test.json).

</mvp_readiness_recheck>
<archive_database_live_updates>

#### Archive and Databases live views — 2026-09-23

The owner requested a stream so Archive and Databases changes appear live. The
owner dashboard now exposes a session-authenticated server-sent invalidation
stream. Open Archive and Databases pages refresh only their visible bounded reads
on stream ticks, retain active filters and pagination, and show connection state.
A reconnect or return to the tab refreshes missed changes. The browser falls back
to a slower refresh cadence during stream failures. The stream carries no row
content; the existing read-only endpoints remain the source of data.

The dashboard build and 29 focused dashboard/auth/maintenance/archive tests pass
after merging concurrent Archive table work. A
synthetic HTTP test covers unauthenticated-stream rejection and proves that
backup closes the stream before its request drain. An isolated loopback preview
on port 18974 visibly updated an open Databases row and an open Archive record
without reloading. The AST-only Graphify refresh covers 531 files, 3,606 nodes,
and 13,432 edges with zero model calls. The full `npm test` run reached 176 tests
but failed five checks because the fresh worktree has no service token or
PostgreSQL test credentials; a focused worker rerun passed with synthetic
tokens. Database-backed acceptance and active installation verification remain
pending. Git integration outcome follows the commit and push attempt.

</archive_database_live_updates>
<archive_reply_table>

#### Connected archive replies — 2026-09-23

The owner asked for clearer Archive columns, a status instead of the ambiguous
Reply column, and the actual assistant message visibly connected to its incoming
message. The table now keeps type, conversation, and agent-copy readiness with
the message; the status column shows incoming reply processing or confirmed
outgoing delivery. A confirmed delivered message appears beneath its incoming
message and opens its own immutable source. When both records are on the page,
the outgoing row also links back to the incoming message. The default browse
order and source-record count are unchanged.

Both storage layouts now resolve links from durable delivery evidence: legacy
outbound result captures and separated-store delivery receipts. Unconfirmed
drafts and uncertain sends do not become reply previews. The pinned Node 24
build, three focused link checks, and all 22 dashboard checks pass. The legacy
PostgreSQL integration case was extended to assert the link, but was skipped in
this session because no isolated PostgreSQL fixture was assigned. An isolated
synthetic browser preview on port 18958 verified the table layout and opening a
reply preview; it does not prove the active installation's stored links. The
active installation was not rebuilt or restarted, so live visual verification
remains pending.

Integration with concurrent Archive media work preserves content-type labels for
voice and other non-text messages in both the table and linked reply preview.
The reconciled Node 24 build and focused regression set pass 28 checks with one
PostgreSQL fixture skip; `git diff --check` passes.

</archive_reply_table>
<archive_browse_order>

#### Newest source records first — 2026-09-23

The owner asked for new items to appear at the top of the Archive table. Both
legacy and separated-store browse routes now order source records by received
time descending, then record ID descending to break ties. Cursor pagination
uses the same order so pages do not skip older records or repeat rows. An
isolated PostgreSQL test with 52 synthetic records, including equal timestamps,
passed on both routes. The dashboard build and 22 dashboard tests passed. The
AST-only Graphify refresh covered 526 files, 3,579 nodes, and 13,348 edges
with zero model calls. The active installation was not rebuilt or restarted;
visual verification there remains pending.

</archive_browse_order>
<owner_database_browser>

#### Legacy combined database label and transition review — 2026-09-23

The owner observed operational tables under the database browser's archive
selection and asked to fix the source-only archive mismatch. The legacy catalog
now labels the physical `nocheh` database **Legacy combined**, matching its mixed
source, derived, and control tables. The browser still exposes the raw tables; the
separate `nocheh_archive` layout remains the actual source-only storage target.
Four focused browser tests, the dashboard build, documentation link and diff checks,
an isolated browser preview of the corrected selector and heading, and the AST-only
Graphify refresh pass. The refresh covered 528 files, 3,590 nodes, and 13,376
edges with zero model calls. The active dashboard was not rebuilt for this label.

A fresh read-only reset preflight recorded 18 owned containers, three volumes,
55 classified installation paths, and one blocker: a running transient Hermes
turn container whose Compose origin does not match the fixed installation plan.
Five external archive review roots contain 16 immediate directories requiring
individual ownership decisions. Fourteen match the exact device/inode identities
of a prior review; two do not. The current legacy database has 51 tables and
aggregate counts of 99 events, two artifacts, 376 derived artifacts, 99 dispatches,
and two action requests. No source content was read or copied, no service was
stopped, and no reset phase was executed. The supported clean transition would
erase installation content; whether to use that transition or preserve current
content through a new migration path needs the owner's choice.

#### Top database and table selectors — 2026-09-23

The owner asked for database and table selectors at the top of the Databases
page. One status-labeled database selector and one table selector now sit above
the full-width details and rows at desktop and phone widths. Table-name search
filters the selector's options while retaining the current selection, and a
database change clears the prior table search and row filters. The unavailable
database state remains selectable and explains why its tables cannot load.

The dashboard build and 22 dashboard tests pass. An isolated synthetic browser
preview verified desktop and 390 px layouts, table switching, table-name search,
database switching, and the unavailable state; the phone page had no document
overflow. The AST-only Graphify refresh covered 525 files, 3,578 nodes, and
13,340 edges with zero model calls. The active installation was not rebuilt or
restarted, so this change has not been checked against its live databases.

#### Database selector visibility fix — 2026-09-23

The owner found the phone picker visible beside the desktop database list. A
general `.nocheh-app label` rule overrode the picker's `display: none` rule at
desktop width. The database picker rules now win that cascade. The isolated
synthetic preview shows only the status list at 1286 px and only the picker at
390 px; the phone page has no horizontal overflow. The dashboard build passes.
The active installation was not rebuilt or restarted for this check.

#### Database explorer layout — 2026-09-23

The owner asked to improve the database viewer's UI/UX and layout after showing
the status cards, detail strip, and table. The explorer now uses one database
list with status and one table list in a left rail, with selected database
details and rows in the right pane. The duplicate database dropdown and tall
intro panel were removed. At phone width, one status-labeled picker replaces
the database list and the detail fields reflow into two columns. The data table
keeps its own horizontal scroll. The dashboard build and 22 dashboard tests pass;
an isolated synthetic preview verified the desktop layout and mobile database
switching. The AST-only Graphify refresh covered 525 files, 3,578 nodes, and
13,340 edges with zero model calls. The active installation was not rebuilt or
restarted.

#### Database status and details — 2026-09-23

The owner asked to show database status and details too. The Databases page now
shows an availability card for every configured database, including a registered
Hermes profile whose database file is not yet created. Selecting a card shows its
engine, database or file identity, service, table count, size, and version when
available, with an explicit missing or unreachable reason otherwise. The status
query is read-only and bounded; database paths and credentials stay out of browser
responses. Four focused Python tests, 22 dashboard tests, the dashboard build,
and an isolated PostgreSQL status query passed. The synthetic localhost preview
showed both available and unavailable cards and the selected database details.
The AST-only Graphify refresh covered 525 files, 3,578 nodes, and 13,340 edges
with zero model calls. The active installation was not restarted or used for this
UI check.

#### Read-only installation database browser — 2026-09-23

The owner requested a raw source database view with sortable and filterable table
rows, extended to all installation databases. The dashboard now has a Databases
page that discovers the configured Nocheh and Inngest PostgreSQL databases,
enabled Honcho PostgreSQL, registered Hermes SQLite profiles, and existing
provider usage and Honcho budget SQLite stores. The legacy installation's
combined PostgreSQL database appears as Archive · legacy. This browser reads
bounded pages and cell previews; it cannot edit rows or accept SQL or a path from
the browser. Redis queues and caches have keys rather than relational tables;
Monitoring shows their service health, not raw keys.

The dashboard build, 22 dashboard tests, and three focused Python browser
tests passed. An isolated PostgreSQL fixture returned the expected discovered
table, columns, sorted row, and column-filter result; its Compose project and
volume were removed afterward. A synthetic localhost dashboard preview verified
the visible table, one-row filter, descending sort, and switch to a Hermes SQLite
table. The AST-only Graphify refresh covered 525 files, 3,574 nodes, and 13,331
edges with zero model calls. The active installation was not rebuilt or restarted,
so live database browsing remains unverified there. Integration status follows
from the commit and push attempt.

</owner_database_browser>

<archive_assistant_replies>

#### Legacy delivered replies missing from Archive — 2026-09-23

The owner reported that a fresh incoming Telegram row showed `Replied`, while the
Archive's `Assistant replies` filter returned no rows. The active installation
still uses the legacy layout. In that path, the spool committed Telegram
`outbound_result` receipts as generated events without projecting a confirmed
Telegram Message response into an original assistant source record. The
separated-store capture path already performed that projection.

Legacy spool draining now captures confirmed delivered messages as source records
and retries an incomplete projection without duplicating the receipt. A bounded
startup sweep recovers delivered messages from retained legacy receipts. Archive
conversation counts now exclude generated operational events and wire captures.
The pinned Node 24 build and PostgreSQL archive check pass in a session-owned
synthetic Compose project, including recovery of an older retained receipt,
idempotent replay, and a database-outage retry. Five focused non-database checks
and all 19 dashboard checks pass. The synthetic project and volume were removed
after verification. The AST-only Graphify refresh covers 519 files, 3,534 nodes,
13,234 edges, and zero model calls. The live installation was not restarted or
inspected with its credentials, so the screenshot's reply is not yet verified
as visible there. Integration status is recorded with the final commit evidence.

</archive_assistant_replies>

<live_mvp_acceptance>

#### Live MVP acceptance in progress — 2026-09-22

The owner requested a real test after the isolated fresh Docker gate. The saved
legacy-layout installation was restarted without erasing its retained database or
bind-mounted state. All 17 required Compose services reached healthy, including
Telegram, the shared provider, Inngest, and Honcho. Diagnostics report no workflow,
worker, tool, scheduler, or subscription-login execution holds; Hermes reports
Telegram connected with the shared provider as the sole refresh owner. The live
subscription gate passed refresh, exact chat, literal detection, and Ogg/Opus
transcription. The content-free result is in
`compatibility/results/2026-09-22-live-mvp-startup.json`.

A read-only reset preflight after startup found 17 installation containers, three
mounted volumes, 53 state paths, and zero ownership blockers. It is not an
executable reset authorization. The saved storage layout is still `legacy`; the
controlled original-only transition, fresh backlog boundary, empty-baseline proof,
post-boundary row-linked acceptance, and separate Honcho production checks remain
pending. The requested fresh owner DM subsequently arrived and completed one
Telegram workflow attempt with one done delivery receipt. Its content-free
evidence is in `compatibility/results/2026-09-23-live-owner-dm.json`.
Owner DM voice, a designated group with a non-owner human reply/reaction,
intentional silence, private/group isolation, exact approval, and restart receipt
recovery await real owner/human traffic. The live test has not established MVP
readiness.

After applying owner-only access to the one selected group, the merged dashboard
image was rebuilt and its local container recreated healthy. A count of group
archive and delivery events since policy activation found no new human group
traffic. The current read-only reset preflight initially flagged the expected
`admin/applied.json` and `admin/settings.lock` files as unclassified. The reset
inventory now plans to erase the stale applied revision and preserve the advisory
lock; 25 focused reset tests pass. Rechecking the live inventory with that code
finds 17 owned containers, zero blockers, and ten remaining reset phases. The
legacy-to-original-only transition and row-linked fresh acceptance are still
pending; no reset or source-content deletion was performed.

The live inspection exposed a Honcho CLI default-root error. The one-level path
fix and focused regression check passed, and `honcho doctor` now reports the
running service and shared login without an environment override. This fix was
integrated into local `main` as `c522e48`. The push to `origin/main` remains blocked
by unavailable HTTPS username credentials.

</live_mvp_acceptance>

<settings_clarity>

#### Settings clarity — 2026-09-23

The Hermes preferences view now contains both per-profile controls and their global
defaults. Each preference has an accessible reset icon beside its input; a reset
is staged until Save. Nocheh settings shows token presence without its value and
explains an empty Telegram group selection. The saved local settings inspection
reported Telegram enabled, owner and bot token configured, zero selected groups,
and `apply_state=current`; no credential value was printed or changed.

After integration with the owner-managed group access increment, the pinned Node
24 full and dashboard builds, 19 dashboard tests, and ten settings/configuration
tests pass. An isolated localhost preview with synthetic settings verified the
desktop layout, reset staging, save feedback, and coexistence with the group
access section without using the active installation. The AST-only Graphify
refresh covers 515 files, 3,507 nodes, and 13,172 edges with zero model calls.
Six direct native scope tests could not run outside the pinned Hermes environment
because the upstream `gateway` module is unavailable on the host. Phone layout
and live runtime behavior were not newly tested.

The owner then requested `****` in configured secret inputs instead of an empty
appearance. The UI uses a placeholder while leaving the input value empty, so an
untouched field still preserves its saved secret. The isolated preview confirmed
the four stars are visible and the input value length is zero. The pinned Node 24
dashboard build, 19 dashboard tests, two settings tests, and AST-only graph refresh
pass; no live credential was read into the browser or changed.

The owner requested a simpler dashboard after seeing the numbered Edit, Save,
Apply strip. Settings now shows the saved/apply status directly above its grouped
fields and keeps its Review, Save, and Apply controls without that strip. The
isolated preview verifies the simplified layout; the pinned Node 24 dashboard
build and 19 dashboard tests pass. The AST-only graph refresh covers 515 files,
3,507 nodes, and 13,171 edges with zero model calls. No live runtime settings
were changed.

</settings_clarity>

<telegram_group_participant_access>

#### Owner-managed Telegram group participants — 2026-09-23

The owner's live group request defined an owner-only default with explicit
participant grants and denies. The selected group's live reply allowlist was
temporarily cleared while the former all-members policy was still running;
owner DM remained enabled. The new policy is implemented in the Telegram
adapter, archive dispatch admission, and final delivery check against the
captured original sender. It is editable through structured dashboard controls
and `./scripts/nocheh group-access`; reset conversion preserves decisions.
ADR-0062 records the configuration and enforcement boundary.

The isolated `./scripts/nocheh test` gate passes, including database-backed
group suppression and 350 native Hermes tests (three skips). The separate
synthetic store HTTP check passes both tests, including the final Telegram
delivery scope check. Docker Compose preserves nonempty JSON configuration.
The synthetic dashboard preview on dedicated port 18849 showed the owner-only
default and working Grant, Deny, and Revoke controls. The AST-only Graphify
refresh covers 515 files, 3,507 nodes, and 13,172 edges with zero model calls.

After integration into local `main` at `f62d817`, the app, Hermes, and dashboard
images were rebuilt. The running local Compose installation applied the new
policy with group replies initially disabled, then restored the one previously
selected group from the private backup with zero participant grants or denies.
All 17 required services are running, Hermes reports Telegram connected, the
live dashboard shows the owner-only default, and no-send checks inside both
running images permit the owner and block an ungranted participant. The
content-free activation result is in
`compatibility/results/2026-09-23-group-policy-activation.json`.

Fresh group human traffic remains pending. The owner's DM receipt above and
synthetic live-image checks do not establish group silence, participant
revocation, source isolation, or MVP release readiness. `origin/main` push is
still blocked by missing GitHub HTTPS username credentials.

</telegram_group_participant_access>

<telegram_group_identity_controls>

#### Telegram group identity controls — 2026-09-23

The owner requested that “Who may address Nocheh in groups” sit under Telegram
settings, auto-fill IDs, and show group and user names beside IDs. The owner-only
directory combines captured live Telegram identities with read-only Bot API
lookups for selected group titles, administrators, and already identified members;
it returns no message content or token. Settings offers group and participant
pickers, keeps manual ID entry for people Telegram has not exposed, and labels
decisions and reviewed changes with names plus numeric IDs when available.
The read-only live lookup returned a group title and visible people. The
owner-only access policy and Save/Apply boundary remain in force. Live group
message acceptance is still pending.
The isolated `./scripts/nocheh test` passed: the TypeScript/dashboard suite
passed and Python ran 353 tests with 3 skips. The synthetic dashboard preview
on port 18849 verified the nested Telegram placement, name-and-ID labels,
known-person ID fill, group selection, and staged Grant action. SQL directory
queries passed read-only parsing against the live archive; that archive has no
captured group updates yet. No live grant or Telegram message was sent.
The feature was locally integrated as `667b86c` and activated by rebuilding and
recreating only `nocheh-app` and `nocheh-dashboard`. All 17 installation services
were running and healthy afterward. The owner-only live dashboard endpoint
returned one named selected group and two named visible people, without a live
grant or group message. GitHub HTTPS credentials were unavailable, so this
integration is not yet pushed to `origin/main`.

</telegram_group_identity_controls>

<telegram_group_access_list>

#### Telegram participant list controls — 2026-09-23

The owner requested a clearer grant/deny UI: show people in a list and switch
each person's access there. The Telegram section now lists each known person and
every saved decision for the selected group with name and ID, a direct No rule /
Grant / Deny choice, and a fixed always-allowed owner row. An unknown person's
numeric ID can be added through a separate manual rule form. Returning a rule to
its saved state removes the pending draft, and Save/Apply remain required before
any running access policy changes. No live grant or denial was applied.

The local build, 19 dashboard checks, and AST-only graph refresh passed. The
isolated preview on port 18849 showed all three states, pending grant count,
pending deny count, manual ID entry, and a return to No rule that disabled Review
changes again. Real group message acceptance remains pending.
The redesign was integrated into local `main` at `5efd9c9`, then only the local
dashboard image and container were updated. A fresh owner dashboard session
loaded the selected group's name and one known participant with direct access
choices. All 17 installation services, including Hermes and the dashboard, were
healthy afterward. No live access decision or running Telegram policy changed.
The remote push remains blocked by the previously rejected publication of local
activation metadata to an unverified remote; GitHub HTTPS credentials are also
unavailable.

</telegram_group_access_list>

<telegram_default_deny_label>

#### Telegram default-deny wording — 2026-09-23

The owner clarified that the group default is deny. The former “No rule”
control meant no individual decision and therefore effective denial under the
owner-only policy, but its label obscured that outcome. Settings now calls the
states Default deny, Grant, and Explicit deny, and explains that Default deny
removes an individual decision while both deny states block the person. The
underlying access policy is unchanged; no live participant decision was made.
The local build and AST-only graph refresh passed. The isolated dashboard
preview showed the default-deny label and separate explicit-deny count; switching
to Explicit deny and back restored the saved default with no pending edit.
The wording fix was locally integrated as `43c593f` and activated by replacing
only the dashboard container. A fresh live Settings page showed Default deny
selected for the known participant and the separate Explicit deny choice. All
17 installation services remained healthy; no access decision was saved.

</telegram_default_deny_label>

<telegram_binary_access_ui>

#### Two-state Telegram group access UI — 2026-09-23

The owner rejected the three-option participant control. Settings now presents
only Denied and Allowed for each visible person and for manual ID entry. Denied
is the effective default; the saved policy can still represent an explicit deny
without exposing it as a third choice. Switching back to the original effective
state restores the saved rule instead of leaving a draft. The owner remains
always allowed, and Save/Apply remain required for any runtime policy change.

The local build and 22 dashboard tests pass, including focused tests for default,
saved grant, and explicit deny transitions. The AST-only code graph was refreshed.
The isolated preview on port 18849 verified exactly two choices, default Denied,
Allowed/Denied switching, the cleared draft on return, and a two-choice manual
form. No live access decision was saved or applied.
The feature was integrated into local `main` as `0843bad`, then only the local
dashboard image and container were replaced. A fresh live Settings page showed
one known non-owner participant as Denied with exactly two choices. All 17
installation services remained healthy. The remote push remains blocked by the
previously rejected publication of private activation metadata to an unverified
remote and unavailable GitHub HTTPS credentials.

</telegram_binary_access_ui>

<mvp_cleanup_recheck>

#### Worktree and Docker cleanup with isolated MVP recheck — 2026-09-22

The owner requested closure of open worktrees, Docker cleanup, a fresh test, and
an MVP readiness answer. Both older session worktrees were clean and already
merged into `main`; they are no longer registered, and their merged branches
were deleted. Their two preview projects and a separate context-graph preview
were removed, including their containers, networks, and fixture volumes. The 17
installation containers and their Compose networks were stopped and removed.
The unrelated `coopr` project was left intact.

Before stopping the installation, `./scripts/nocheh backup --leave-stopped`
created the private snapshot at `data/backups/pre-mvp-clean-20260922` (60 state
files and 50 tables). `validate_snapshot` passed. The saved installation still
selects the legacy storage layout. Automatic approval review rejected deletion
of its primary PostgreSQL volume because the broad cleanup request and local
backup did not establish authority to discard that legacy database. The volume,
the old unlabeled Honcho experiment volume, and bind-mounted runtime state were
retained; the installation remains stopped. This is a Docker cleanup and isolated
test, not a completed three-store product reset or empty live installation.

The repository's `./scripts/nocheh test` passed from an isolated temporary
Compose project with a newly created database volume and synthetic credentials.
Its temporary containers, volume, and networks were removed. The Hermes portion
ran 348 tests with three skips. No fresh owner Telegram text, voice, dedicated
group human activity, exact approval, reconnect/restart, post-boundary row-linked
reset acceptance, or Honcho production acceptance was performed. Those live gates,
the original-only storage transition, and GitHub push remain pending; the local
test pass does not establish MVP readiness.

</mvp_cleanup_recheck>

[SPECS.md](SPECS.md) defines the intended product. [AGENTS.md](AGENTS.md) defines
how agents work. Plans below provide execution order and acceptance procedures;
this file records actual status. Historical counts are evidence from their recorded
runs, not tests repeated by the documentation migration.

<honcho_comparison_retirement>

#### Retire the optional Honcho comparison — 2026-09-22

The owner asked to remove `experiments/honcho` and similar obsolete experiment
surface. The synthetic Hermes-versus-Honcho fixture, its separate Compose stack,
baseline runner, live-comparison command, and pending task entry are removed.
Production Honcho's source pin, metered gateway, read-only CLI, and focused
security/budget tests now live with the installed integration. The management
image no longer copies an experiments directory. The owner-facing Honcho view
describes production services, and ADR-0061 records the decision while preserving
the accepted historical ADRs.

The active installation's `data/honcho-experiment` state path, database identity,
external volumes, and spending ledger retain their names and contents. Legacy
project/volume checks remain to prevent competing writers or accidental new
empty memory. No production services, provider login, memory attachment, monthly
budget policy, or stored data were changed by this code cleanup.

Verification: 22 focused Python tests pass for metering, configuration, CLI
selection, runtime volume isolation, and portability; three pinned CLI/SDK and
workspace-boundary tests pass in a separate image with no network or state mount.
The dashboard build and all 19 dashboard checks pass. A Node 24 synthetic
preview on port 18954 shows the Honcho Memory view with production labels and
the expected connection status; its project, network, volume, image, and
credentials are separate from the installation. The AST-only Graphify refresh
covers 514 files, 3,498 nodes, and 13,128 edges with zero model calls. Live
production image recreation and runtime migration were not part of this check.
After local integration, the running Honcho gateway was healthy but still reported
the former `experiments/honcho/meter.py` bind mount. The host path is removed in
the new checkout; container recreation using the new Compose mount, image, and
live health checks remains pending. Git integration alone did not authorize that
runtime change. The GitHub push failed because this host has no HTTPS username
credential; local and remote `main` remain separate.

</honcho_comparison_retirement>

<fresh_mvp_test_baseline>

#### Fresh local data baseline and MVP test — 2026-09-22

The owner asked to close all session worktrees, clear the databases, and test from
fresh data to assess MVP readiness. The read-only reset preflight found 17 owned
containers, three mounted database/cache volumes, and no ownership blockers. A
private recovery backup completed at `data/backups/pre-mvp-reset-20260922` before
shutdown. The three owned PostgreSQL/Honcho Redis volumes were removed, and 37
active content paths were moved to `data/retired/pre-mvp-reset-20260922/`. The
provider monitor sanitizer erased content fields and preserved usage accounting;
the shared login, provider keys, Honcho setup, and spending ledger were retained.
These private paths are outside active runtime mounts and are not committed.

Fresh volumes were created and the pinned images rebuilt. All 17 required services
became healthy. The shared login is present and Telegram reports connected. The
new archive has no incoming Telegram source messages; its four records are two
generated outbound intents and two generated outbound results. The prior uncertain
Telegram receipt remains only in the private backup and was not replayed. Fresh
live subscription checks pass refresh, chat, literal detection, and required
transcription. The isolated Docker test gate passes 119 Node checks with 46
explicit skips, the separate database-recovery check, and 348 Hermes tests with
three skips. Three stale Hermes graph tests initially failed because they expected
event and profile nodes; they were updated to the context-entity contract and the
full gate passed after local integration. Graphify's AST-only refresh covers 518
files, 3,632 nodes, and 13,338 edges with zero model calls.

This operational wipe is not a completed product reset. The saved installation
still selects `NOCHEH_STORAGE_LAYOUT=legacy`, so the required archive, derived,
and control database layout and its controlled legacy-to-original-only transition
have not passed live acceptance. The documented reset journal, fresh Telegram
backlog boundary, and post-reset row-linked acceptance were not executed. Real
owner Telegram text, voice, group silence/isolation, exact approval, and restart
checks remain pending; synthetic checks and service health do not establish MVP
readiness. The complete isolated gate was rerun at merge `63a812b`; concurrent
dashboard commits have their own focused checks but were not included in that
specific full-suite run. Git fetch and push remain blocked by missing HTTPS
username credentials, so local and remote `main` are not synchronized.

</fresh_mvp_test_baseline>

<dashboard_page_design_review>

#### Dashboard page design review — 2026-09-22

The owner asked to check and fix all pages, citing Settings as a poor example.
All 12 sidebar routes were inspected in the isolated synthetic preview at desktop
and 390px widths. The large Settings issue was an unpadded fieldset background
that swallowed section labels and controls. Its category bar also clipped the
third tab on phones. Settings now uses bounded, padded sections, a two-row phone
tab layout, aligned preference rows, and distinct review and apply panels. Shared
page text and panel spacing were adjusted for readability. The Archive and Activity
tables retain their intentional, contained horizontal scrolling on phones.

The standalone dashboard build, all 19 dashboard checks, and the pinned Node 24
development image build pass. Every sidebar route has zero page-level horizontal
overflow at 390px in the synthetic preview. The final Settings category layout
was checked again at desktop and 390px widths. The AST-only Graphify refresh
covers 518 files, 3,516 nodes, and 13,162 edges with zero model calls.
Runtime settings save/apply, Telegram, Hermes, CPA, and live provider behavior
were not exercised by this visual pass.

</dashboard_page_design_review>

<sidebar_toggle_layout>

#### Sidebar toggle placement — 2026-09-22

The owner asked to remove the collapse button from the bottom of the desktop
sidebar and show it at the top as an icon button. The toggle now sits beside the
Nocheh brand when expanded and beneath the brand mark when collapsed, keeping
the existing labeled expand/collapse action and saved sidebar state. The mobile
navigation drawer has no redundant collapse control.

The dashboard build and all 19 dashboard checks pass. The isolated synthetic
preview verifies both desktop sidebar states and the control's accessible label.
The pinned Node 24 preview image builds. The AST-only Graphify refresh covers
518 files, 3,516 nodes, and 13,162 edges with zero model calls. No live runtime
service or Telegram behavior was changed.

</sidebar_toggle_layout>

<sidebar_footer_caption>

#### Sidebar footer caption — 2026-09-22

The owner asked to remove “Local owner dashboard.” The shared sidebar and mobile
drawer footer now show only the Hermes and CPA dashboard links. The dashboard
build, all 19 dashboard checks, and the pinned Node 24 preview image build pass.
The isolated synthetic preview confirms the caption is absent at desktop and
390px mobile widths. The AST-only Graphify refresh covers 514 files, 3,532 nodes,
and 13,228 edges with zero model calls. No live runtime services were changed.

</sidebar_footer_caption>

<honcho_attachment_controls>

#### Honcho attachment option layout — 2026-09-22

The owner reported a Honcho attachment form whose consent checkboxes appeared as
oversized boxes separated from their labels. The shared text-input rule was
setting checkbox width and minimum height. The two existing options now sit in
one labeled group with compact checkboxes, full-row click targets, and explanatory
copy underneath. The attachment command and consent semantics are unchanged.

The dashboard build and all 19 dashboard checks pass. The pinned Node 24
development image builds. The isolated synthetic preview on port 18943 verifies
the layout on desktop and at 390px, plus label-click toggling. It has no Telegram
poller, provider login, scheduler, or external execution authority. No live Honcho
attachment was attempted. The AST-only Graphify refresh covers 518 files, 3,516
nodes, and 13,162 edges with zero model calls.

</honcho_attachment_controls>

<native_dashboard_shortcuts>

#### Hermes and CPA sidebar access — 2026-09-22

Direct links to the native Hermes and CPA dashboards are restored in the Nocheh
sidebar and mobile navigation drawer. The desktop sidebar keeps the links visible
while its main navigation scrolls. The links use the existing owner-session proxy
routes `/hermes/nocheh` and `/providers/management.html`; Integrations also retains
its runtime and provider details and links.

The dashboard build passes, all 19 dashboard checks pass, and the pinned Node 24
development image builds. An isolated synthetic preview on port 18943 verifies the
expanded and collapsed desktop sidebar, the 390px mobile drawer, and navigation to
both fixture boundary pages. It has no Telegram poller, provider login, scheduler,
or external execution authority. The AST-only Graphify refresh covers 518 files,
3,516 nodes, and 13,162 edges with zero model calls. Live Hermes and CPA proxy
behavior was not rerun.

</native_dashboard_shortcuts>

<original_only_archive>

#### Non-text source content in Archive — 2026-09-23

The owner identified a textless Telegram voice message shown as `(No message
text)` and requested UI support for other non-text content. Archive browse and
search results now carry original content-type hints, and the table and Sharing
source picker name voice and other media or structured messages while retaining
message text when it exists. Original details show the content type, useful
structured fields, attachment readiness and duration, a download action, and
explicit click-to-load previews for supported audio, video, and image files.
Preview failures leave the original download available. The immutable original
and guarded agent copy remain separate.

The pinned Node 24 development image build, 23 dashboard tests, and four focused
synthetic PostgreSQL checks pass, including content classification and browse
pagination in both storage layouts after merging the concurrent main changes.
An isolated Compose preview on localhost port 18968 uses its own database,
network, image, and project; visual inspection confirmed the voice row, detail,
and audio control. No installation service, provider, poller, scheduler, or
credential was used. The AST-only Graphify refresh covers 530 files, 3,590
nodes, and 13,376 edges with zero model calls. Live installation verification
and production activation were not performed.

#### Archive status, filters, and message-detail clarity — 2026-09-22

The owner clarified that `Needs review` looked like an approval request even
though no approval action existed, that work proven not to have reached Telegram
must be retried through Inngest, that the Archive's source-only behavior was an
invisible fixed filter, and that the record editor exposed too much internal
detail. Archive now labels a pre-delivery failure `Retry scheduled` with the
explicit note `Inngest will retry`. A genuinely uncertain remote send is instead
`Delivery uncertain` with `Not auto-retried`; neither is presented as an
approval. The existing dispatch contract continues to return pre-delivery
failures as retryable work under a fresh attempt identity and keeps only sends
that may have started terminal and uncertain. A supervised receipt reconciler
also inspects legacy `dispatch_interrupted` outcomes through Hermes `run.events`.
It reopens the Inngest workflow under a new dispatch and attempt only when the
complete durable journal contains assistant progress and no delivery-stage event.
Incomplete evidence or any delivery progress remains terminal, preventing a
duplicate Telegram reply.

The build, two focused journal-classification checks, the source-only Archive
check, and all 18 dashboard checks pass. The separated-store PostgreSQL fixture
now covers the full ambiguous-to-failed receipt transition, fresh Inngest
dispatch, second runtime attempt, and the delivery-progress no-retry case; that
fixture remains pending in this worktree because no isolated stores fixture was
assigned. The broader synthetic run passed its non-database checks; four
unscoped PostgreSQL integration tests could not authenticate without a database
password and are not claimed as passes. The AST-only Graphify refresh covers
518 files with 3,511 nodes and 13,148 edges and zero model calls.

The Archive now has visible, server-backed filters for record/message direction,
conversation scope, and reply-processing state. The default is explicitly `All
source records`; operational attempts and receipts remain in Monitoring rather
than becoming archive rows. Invalid filter values fail closed. The message action
is now `Open`, and the selected panel prioritizes two ordinary concepts: the
permanent read-only original and the separately editable agent copy. Generated
items, provenance, raw agent-copy fields, source identity, and export controls
remain available under advanced disclosures.

The TypeScript/dashboard build, all 18 dashboard tests, and four focused Node
archive/filter checks pass. The host Python environment lacks the pinned Telegram
package, so the Hermes gateway test was not rerun there; the change does not alter
that gateway, and its existing focused pre-delivery/post-delivery regression
remains in place. An isolated synthetic preview on port 18941 verifies all-source,
incoming-message, and retry-status filtering plus the simplified original/agent
copy detail panel. It contains no credentials, provider, poller, scheduler, or
external-effect authority.

#### Telegram follow-up recovery and source-only Archive — 2026-09-22

Live diagnosis of the owner's MVP test found that the first Telegram turn held the
selected native profile while it completed, so the second captured message waited
behind it. The second turn then exhausted the former 15-second prepared-context
deadline before model execution or Telegram delivery began. The Hermes gateway's
outer exception handler incorrectly classified that pre-delivery failure as an
ambiguous possible delivery, which made the durable dispatcher treat it as terminal
and never try it again.

Prepared context now has a bounded 60-second deadline for cold guarded preparation.
Hermes records when Telegram delivery actually starts: failures before that point
are retryable under a fresh attempt identity, while interruptions after sending may
have begun remain ambiguous and are never automatically resent. Both the legacy and
separated-store dispatchers preserve that distinction, expose retryable failure to
the workflow owner, and make the first safe retry due after about ten seconds. The
selected-profile ordering and duplicate-delivery protections remain intact.

The owner Archive now defaults to source evidence only. Generated records, Telegram
wire captures, outbound intents/results, and other operational receipts do not
appear as message rows; they remain available in Monitoring. Incoming Telegram rows
show reply progress separately from source capture and guarded-copy readiness, with
explicit queued, working, retrying, replied, no-reply, cancelled, and needs-review
labels. The prior `outbound intent` and `outbound result` rows are operational
request/receipt evidence, not independent source messages.

The focused pinned-container regression set passes eight Node/dashboard checks and
five Hermes checks, covering archive browse/search filtering, owner-only source
search, reply status, fresh retry attempts, terminal uncertain delivery, manual
owner retry, the longer context deadline, and pre/post-delivery failure handling.
The broader sequential Node/dashboard run reached 152 passes and four expected
environment skips; its only remaining failure was an unrelated portability fixture
whose prebuilt image omitted current Hermes modules. The reconciled pinned Node
build, 12 Archive/Graph dashboard checks, and five focused Hermes checks pass. The
AST-only Graphify refresh covers 515 files with 3,491 nodes and 13,081 edges and
zero model calls. The services, management, and Hermes images were rebuilt from
merged `main`; the app, security, dashboard, executor, and Hermes containers were
recreated and all installation services report their expected healthy state. The
live Archive visibly lists the two source messages only, labels their reply states
`Replied` and `Needs review`, and contains no outbound or wire rows. No workflow is
running or retry-failed. The old ambiguous receipt remains closed to prevent a
duplicate delayed send; a fresh two-message owner Telegram acceptance remains
pending.

#### Context-entity graph filtering — 2026-09-22

The owner requested that redundant graph nodes be filtered: useful graph nodes
are users, projects, groups, and messages, while actions and events are context,
not graph entities. The graph contract, management adapter, browser allowlist,
legend, labels, and 3D styles now enforce exactly those four node kinds. Legacy
scope/author nodes are normalized to group/user nodes during rollout;
`runtime_context`, operational events, files, generated derivatives, native
profiles, and memory-note nodes are removed together with dangling links.
Original source and derived records are unchanged and remain available in their
authoritative inspection surfaces. The separated-store graph also adds explicit
project-to-group context from current project assignments without granting access.

The pinned Node 24 development image builds successfully. All eleven focused 3D,
browser, and management-adapter graph checks and all 18 dashboard checks pass, and
both the legacy PostgreSQL graph test and separated-store retrieval graph test
pass against an isolated synthetic PostgreSQL cluster. The broader container
suite completed 72 passes and 80 explicit skips; five unrelated workflow tests
failed because that general run intentionally had neither the default PostgreSQL
fixture nor the required runtime token, so it is not recorded as a full-suite
pass. `git diff --check` passes. The AST-only Graphify refresh covers 515 files
with 3,489 nodes and 13,074 edges and zero model calls. An isolated owner preview
on port 18935 visibly shows 12 user/project/group/message nodes, all four type
filters, and no runtime nodes; searching `runtime_context` returns zero matches.
The preview uses no live credentials, provider, poller, scheduler, or
external-effect authority. Production
services were not rebuilt or activated by this change.

#### Human-readable evidence graph identity labels — 2026-09-22

The owner asked whether the graph can show usernames and group names after a
private conversation node and its author both appeared as `123`. User nodes now
prefer the `@username` recorded in the original Telegram observation, then its
recorded first/last name. Group nodes prefer the recorded chat title. A private
conversation is explicitly labeled `Private chat · @username` (or its recorded
display name), so it remains distinct from the participant even though Telegram
uses the same external ID for both. Numeric IDs remain fallbacks. Stable node IDs,
relationships, source records, and access behavior are unchanged.

The pinned Node 24 development image builds successfully. All 13 focused graph
label/browser checks, all 18 dashboard checks, and both the legacy and
separated-store PostgreSQL graph regressions pass. The host-only build is not
counted because that worktree's host `node_modules` lacks the pinned `elkjs` and
React Flow packages; the clean pinned container installs and builds them. The
isolated synthetic preview on port 18935 visibly shows `@mira_sky`,
`Private chat · @mira_sky`, `Observatory team`, and `Field reports` as distinct
nodes. It has no live credentials, provider, poller, scheduler, or external-effect
authority. Production services were not rebuilt or activated.

Feature commit `c40eddd` is merged into local `main` by `aa17afe`, preserving the
concurrent live-archive work already on `main`. The post-merge focused and full
dashboard checks pass. Fetch and push remain blocked because the HTTPS GitHub
remote has no available username credential; local `main` is therefore ahead of
`origin/main` at `9c13606` and remote synchronization is pending.

#### Private Telegram conversations are not groups — 2026-09-22

The owner clarified that the apparent group sharing a Telegram ID with a user was
actually the user's direct conversation with the bot and directed that it be
fixed. Telegram private-chat IDs may equal the participant's user ID, but the two
namespaced graph identities remain distinct. Conversation nodes now retain their
stable `group` entity kind for the four-kind graph contract while exposing the
recorded Telegram `chat_type` as presentation metadata. A private conversation is
shown as type `Private chat` in the node browser, search, filter, legend, accessible
title, and inspector; a real Telegram group remains type `Group`. An unnamed direct
conversation is labeled `Private chat · <numeric ID>` instead of a bare numeric ID.

The pinned Node 24 image builds successfully. All 14 focused graph checks, all 19
dashboard checks, and both the legacy and separated-store PostgreSQL graph
regressions pass against an isolated synthetic PostgreSQL cluster. `git diff
--check` passes. The AST-only Graphify refresh covers 517 files with 3,511 nodes
and 13,154 edges and zero model calls. The isolated synthetic preview on port
18935 visibly distinguishes `PRIVATE CHAT · Private chat · @mira_sky` from `USER ·
@mira_sky`; searching `private chat` returns one node, and the selected-node
inspector says `Private chat`. The preview has no live credentials, provider,
poller, scheduler, credential refresh, or external-effect authority. Production
services were not rebuilt or activated.

#### Worktree consolidation and clean real-test baseline — 2026-09-22

The owner directed that all session worktrees be closed, their work merged into
`main`, and the local Docker/runtime databases be rebuilt from a clean baseline
for new real tests. All six non-main worktrees were clean before removal and
their branches are ancestors of `main`; the only outstanding branch work, the
consolidated Memory workspace, is merged by `ebbbee4`. Only the main worktree
remains. The local branch is nine commits ahead of `origin/main`; fetch and push
remain blocked because the HTTPS remote has no available username credential.

All Nocheh containers, Compose networks, old image tags, PostgreSQL volumes,
Honcho database/cache volumes, preview resources, and the final verified-empty
anonymous volume were removed. The unrelated `coopr` Compose project was left
untouched. A no-cache build with refreshed pinned bases completed successfully
for the services, management, Hermes, Honcho, CLI proxy, and provider-monitor
images. No Nocheh service was restarted, so the fresh baseline remains stopped.

Active archive, derived, control, workflow, native-memory, session, cache, and
test-report state is empty. The configured Honcho PostgreSQL and Redis volumes
were recreated empty; the primary PostgreSQL volume is intentionally absent and
will be created on first startup. Provider credentials and configuration,
provider accounting, and the Honcho spending ledger were retained. The provider
monitor database was scrubbed through the pinned reset sanitizer. Recoverable
bind-mounted pre-reset state is quarantined under
`data/retired/pre-real-tests-20260922/` and is outside the active runtime paths.
The merged dashboard suite passes all 17 checks, and the clean pinned Node 24
Docker build passes.

On the owner's subsequent directive to run Nocheh fully, the configured stack
started with Honcho and Telegram enabled. All 17 required runtime services are
healthy; the two inspection CLIs remain stopped as intended. The tools image also
built successfully. Live diagnostics report no execution holds, the four core
service heartbeats present, provider and monitor healthy, subscription login
available, and Telegram connected. The synthetic live runtime gate passes provider
refresh, exact chat, secret detection, and subscription transcription. Those four
guarded verification events are the first content in the new archive; they produced
no Telegram deliveries or actions. The owner dashboard responds on
`http://127.0.0.1:8783/`.

#### Evidence graph node identity labels — 2026-09-22

The owner found that distinct historical Hermes profiles and textless system
observations appeared to be duplicate graph nodes because their visible labels
were identical. The graph keeps every underlying identity and relationship, but
now labels configured profiles as current, historical profiles with guard epoch
plus a stable profile fragment, and textless observations with their
event kind plus a stable short event ID. The profile registry exposes the bounded
guard-epoch metadata already present in each profile marker; no source or
memory record is merged, deleted, or rewritten.

The pinned Node 24 image builds successfully. Eleven focused graph/dashboard
checks, all 17 dashboard checks, three legacy graph-enrichment tests, and the
focused historical-profile registry test pass. The host-only combined Python
module run was not counted because this host lacks PyYAML and an unrelated restore
test's fixed port was already occupied; the focused Python checks pass in the
pinned Hermes container.

After local integration, the services, management, and Hermes images rebuilt from
the pinned bases and the three affected services were recreated. All active
Compose services report healthy. The authenticated live graph returns 18 nodes and
17 links with no repeated labels, and the owner browser visibly shows the distinct
current/historical profile and intent/result labels. Recreating the runtime added
four more content-free Telegram webhook-control audit observations (intent plus
result pairs); these are operational evidence, not conversation test data, and no
delivery or external message was created.

#### Archive owner table and editing flow — 2026-09-22

The owner requested a place to see database records in a table and edit them.
The Archive is now one explicit owner workflow: find or browse immutable original
messages in a searchable, paginated semantic table, select **View / edit**, review
the source evidence, and edit the separate guarded copy used by agents. The table
shows message text, type, scope, received time, and agent-copy readiness. Its edit
action remains sticky in the horizontally scrollable phone layout.

Inert single-page pagination is omitted; multi-page browsing uses the shared
balanced pager and clears stale detail selection when its page changes. Selection
is deep-linked, the original precedes the compact revision-checked agent-copy
editor, and technical fields are progressively disclosed. Raw database rows and
original evidence remain read-only. The optional pgweb guide directs ordinary
editing to the owner dashboard.

All 16 dashboard checks, `git diff --check`, and the clean pinned Node 24 full
Docker build pass on the merged main tree. The AST-only Graphify refresh covers
514 files with 3,589 nodes and 13,227 edges and zero model calls. The isolated
synthetic preview on port 18933 verifies the full-width desktop table, deep-linked
selection, the original-to-agent-copy editing flow, and the sticky edit action at
390px. Telegram and all external execution authorities are disabled. The host
standalone dashboard build was not counted because its pre-existing `node_modules`
does not include the current lockfile's React Flow and ELK dependencies; the clean
container build installs that lockfile and passes.

#### Unified Memory relationship and access map — 2026-09-21

On 2026-09-22, the owner requested smaller Memory map nodes. The graph uses compact label-first cards with narrower width, reduced padding and visual weight, and no repeated action helper line inside every node. ELK fallback dimensions match the rendered card footprint so initial and reset layouts remain stable; automatic fit is capped below 1× so the canvas does not enlarge compact cards back to their old visual footprint, while manual zoom remains available. Connection handles retain their existing interaction size. All 15 dashboard checks, the standalone dashboard build, and the pinned Node 24 full build pass. The isolated preview verifies the compact cards at desktop and 390px, including a shortened mobile reset label with the full accessible name preserved.

On 2026-09-22, the Memory map was refined into a clearer owner workspace: a compact icon-backed legend, deferred search with clearable filters, accurate result summaries, explicit Map and grouped List views, wider edge interaction targets, and a combined tabbed access-review panel. The graph switches from horizontal to vertical ELK layout below 700px, while the complete list keeps every loaded record—including facts hidden from the graph—keyboard accessible. The isolated synthetic preview now provides representative people, project, conversation, topic, fact, relationship, assignment, access, suggestion, request, grant, settings, and project data. The pinned Node 24 Docker build, standalone dashboard build, and all 15 dashboard checks pass. Browser acceptance covers search and clearing, fact expansion, the fact detail editor, complete-list coverage, access-review tabs, and desktop and 390px layouts. The AST-only Graphify refresh covers 510 files with 3,469 nodes and 13,045 edges and zero model calls. The preview remains isolated on port 18932 with Telegram and external execution authorities disabled; no production activation or provider action was performed.

On 2026-09-22, the static SVG was replaced by an interactive React Flow canvas with draggable labeled cards, pan and zoom, fit controls, a minimap, deterministic layout reset, keyboard selection, reduced motion, and the complete list fallback. The map now uses pinned elkjs and the ELK layered algorithm to place connected records, minimize crossings, space disconnected components, and recalculate after filtering or fact expansion; asynchronous results are revision-fenced and a fixed-column fallback remains available. Selecting any graph item opens its semantic editor: people can be renamed; projects and project assignments edited; facts and relationship type/wording corrected; suggestions edited and decided; and access revoked. Drawing a supported connection opens a reviewed persistent-grant or project-assignment form and does not save by itself. All data changes remain owner-only, idempotent, and revision-checked. The TypeScript and dashboard builds pass and all 15 dashboard checks pass. The focused entity and memory-access PostgreSQL tests compile and skip without the explicit fixture; attempts to reach localhost PostgreSQL were sandbox-denied or did not authenticate as the isolated fixture, so they are pending rather than passed. The same isolated preview verifies node and edge rendering, person and relationship editors, expanded-fact ELK relayout, and desktop and 390px mobile layouts. The refreshed AST graph covers 510 files with 3,455 nodes and 13,026 edges.

On 2026-09-22, owner review found that the first graph did not explain its colors, initials, line styles, or hidden-fact count. The map includes a visible plain-language legend for all five node and four connection types, states which connections grant no access, labels every displayed card and connection, distinguishes shown nodes from collapsed facts, and gives an inspection instruction.

The owner-only Memory map is implemented as a separate interactive React Flow and list view. It projects people, projects, conversations, topics, versioned facts, descriptive relationships, project assignments, explicit access, and private suggestions. Fact nodes are collapsed by default; the page provides search, type and state filters, pagination status, keyboard-operable controls, reduced-motion behavior, responsive layout, a complete list fallback, evidence and technical detail panels, and global or per-destination delivery settings. The existing Evidence Graph is unchanged.

Control storage now owns revisioned access settings, review requests, decisions, lifecycle state, and one-time or persistent fact grants. Derived storage owns the exact guarded wording and owner-only provenance. Relationships and project assignments never grant access. Scoped recall returns only persistent active grants for the exact group or topic. One-time grants remain bound to their request and become consumed only after a confirmed follow-up receipt. Fact revision, guarded representation, evidence authorization, or guard-generation changes suspend a grant before reuse. Rejection closes the current request only, so a later independent group turn can create a new high-relevance suggestion.

The trusted suggestion path runs after successful group delivery, starts from scoped entities, follows the existing depth-three cycle-safe relationship traversal, deduplicates by source turn, filters already readable or granted facts, and never enters the group answer context. Owner notifications contain only a content-free authenticated dashboard link. Owner approval can retain the proposed wording or replace it with safe wording, select one-time or persistent access, and automatically enqueue the exact follow-up through the existing guarded Telegram action and receipt workflow. Owner-private recall remains unchanged and creates no access request.

The owner APIs are available under `/v1/memory-map` and `/v1/memory-access/*`. Portable derivative history declares every new settings, request, decision, and grant record; imported operational authority remains history-only. Full backup and inactive restore already include all store tables. Reset preservation now snapshots and restores the global defaults and destination overrides while fresh-baseline verification requires request, decision, and grant tables to be empty.

The TypeScript and dashboard builds pass. Fifteen dashboard checks pass, including the new map contract; six non-database security/privacy checks pass and four PostgreSQL checks skip without the explicit fixture. Ten reset-configuration checks pass. A full `npm test` run builds successfully and reports 61 passes, 80 fixture skips, and 13 environment failures: the sandbox denies localhost listeners and PostgreSQL connections, while worker and metrics cases require an unavailable service token. The focused PostgreSQL memory-access, owner API, portability, reset, and Telegram workflow tests compile but remain pending because `NOCHEH_STORES_FIXTURE` is not enabled. Additional Python reset/privacy modules are pending because this host Python lacks `yaml` and `httpx`. An isolated frontend-only preview on port 18921 verifies desktop and 390px mobile layouts, fact expansion, access/suggestion edge distinction, exact wording review, Reject once, revocation, global defaults, and destination overrides without starting installation services. The AST-only Graphify refresh covers 509 files with 3,428 nodes and 12,984 edges and zero model calls.

Contract/schema commit `97c028d`, access-workflow commit `1c87685`, API/UI commit `d52049b`, and acceptance/portability commit `835ac85` are merged into local `main`; the final merge is `f0cb23f`. Fetch and push remain blocked because the HTTPS Git remote has no available username credential. No production Honcho activation, provider cutover, live Telegram action, or installation resume was performed.

#### Connected memory for people and projects — 2026-09-20

On 2026-09-22, the owner consolidated every memory surface into one Memory workspace. Its four direct views cover native notes and history, learned interpretations, stored Honcho data, and relationships with access decisions. The relationship view keeps person and project editing alongside explicit grant, one-time deny, persistent approval, and revoke controls. Separate People, Memory map, Learned, and Honcho navigation destinations are removed; legacy bookmarks open the matching Memory view. The mobile workspace uses a visible two-by-two tab layout instead of hiding the selected relationship view in a horizontal scroller. The standalone dashboard build, all 16 dashboard checks, `git diff --check`, and the pinned Node 24 production image build pass. The AST-only Graphify refresh covers 512 files with 3,477 nodes and 13,052 edges and zero model calls. The isolated preview on port 18932 verifies all four Memory views, legacy Honcho and Memory-map bookmarks, explicit grant/deny controls, dark and light themes, desktop, 375px portrait, and phone landscape layouts; Telegram and external execution authorities remain disabled.

On 2026-09-22, shared owner-list pagination was refined after the People & projects view exposed an inert single-page control row. Single-page lists now omit pagination entirely. Multi-page lists use a semantic, centered pager with equal previous and next columns and a vertically aligned current-page label. All 15 dashboard checks, the standalone dashboard build, and the pinned Node 24 full build pass. The isolated preview verifies the corrected People and Identity suggestions sections at desktop and 390px.

On 2026-09-22, the dashboard information architecture was consolidated after an owner review of redundant features. Sharing is the sole conversation-access destination while legacy `#spaces` bookmarks resolve to it; Overview retains status, metrics, attention, and common tasks while Monitoring owns analytics; Integrations remains the canonical Hermes and provider entry point; and project memory now lives beside project records and assignments in the Projects workspace while People is person-only. The sidebar removes the duplicate Memory access destination and repeated integration shortcuts. The standalone dashboard build, all 16 dashboard checks, and the pinned Node 24 production image build pass. The refreshed AST graph covers 511 files with 3,471 nodes and 13,044 edges and zero model calls. The isolated preview on port 18932 verifies Overview, People, both Projects tabs, legacy bookmark compatibility, and the 390px layout; Telegram and external execution authorities remain disabled.

Implementation is complete in the separated-store runtime. Control storage owns stable person/project identities, exact and confirmed bindings, suggestions, reversible link history, and versioned Honcho peer mappings. Derived storage owns revisioned entity claims and relationships with direct, reported, or inferred attribution and source evidence. The original archive remains unchanged.

The Honcho writer uses actual speaker peers, persistent conversation sessions, and separate typed entity-evidence sessions for projects and mentioned people. Connected recall starts from a permitted entity, follows bounded evidence-backed paths with cycle detection and deduplication, labels why related memory was included, and retains the 20,000-character context ceiling with partial-result status. The first version-4 write retires the corresponding generic-peer generation in place. No production Honcho activation or live installation resume is authorized by this change.

Owner and scoped APIs under `/v1/entities` expose audience-filtered search, current memory, evidence, relationships, uncertainty, and correction history. Owner commands review suggestions, link or unlink identities, and correct or retire claims. The dashboard adds People and Project memory views while keeping inferred relationships separate from the observed-source Graph page.

The focused isolated PostgreSQL acceptance passes four checks with no skips: same-name separation and stable platform identity; reported attribution; Atlas–Beacon contextual and multi-step recall with cycles, bounds and privacy; typed Honcho ingestion and uncertain-write recovery; and complete portable entity history. The TypeScript/web build, 14 dashboard tests, and `git diff --check` pass. The AST-only Graphify refresh records 3,470 nodes and 15,232 edges. Desktop browser acceptance covers People, Project memory, suggestions, evidence, reported attribution, contextual relationships, corrections, and history at the isolated preview. [Content-free evidence](compatibility/results/2026-09-20-connected-entity-memory.json).

An attempted complete container suite reached the existing dashboard-boundary fixture and timed out because its external host aliases were unavailable in that test container; it is not recorded as a pass. Live Honcho provider acceptance, production activation, and resuming the installation remain pending under the existing gates.

The owner-facing Compose names now describe the three core boundaries directly:
`hermes` is the single managed Hermes core, `hermes-agent-sb` launches isolated
agent sandboxes, and `nocheh-db` owns PostgreSQL. Internal database names remain
`nocheh_archive`, `nocheh_derived`, `nocheh_control`, and `nocheh_inngest`, with
separate restricted roles. The full containerized test entrypoint passes 107
service checks with 44 environment-specific skips, the isolated database-loss
check, and 343 Hermes checks with three skips. A fresh database rehearsal confirms
all four databases, restart preservation, invalid-credential failure, disabled
restore roles, and zero bootstrap containers. The persistent synthetic preview is
running all 12 configured core services healthy under the new names. Telegram and
Honcho remain disabled in that isolated profile; the live installation still
requires its pending reset and Telegram acceptance gates.
[Service-name evidence](compatibility/results/2026-09-20-core-service-renames.json).

The owner requested removing the visible `nocheh-store-bootstrap` container and
merging its work into the related service. The original-only layout now builds a
dedicated `nocheh-store-postgres:local` image and runs the existing idempotent,
advisory-lock protected archive/derived/control/Inngest provisioning inside
`nocheh-db` before its health check succeeds. `nocheh-app` and
`nocheh-security` retain only restricted store credentials. Inactive restore
starts PostgreSQL without ordinary provisioning and performs workflow-only setup
inside that database container; the explicit reset setup command remains
separate. ADR-0054 records the placement decision.

A fresh disposable database rehearsal provisions all four databases, preserves
the installation generation across restart, fails closed on an invalid role
credential, and keeps restored runtime roles `NOLOGIN`. The complete isolated
installation rehearsal passes all 19 recorded checks with deterministic provider
fixtures and zero external calls, including capture, guarding, native memory,
learning, delivery, database/workflow outage recovery, and cleanup. Coordinated
format-6 backup and inactive restore preserves 7 archive, 14 derived, 53 control,
14 workflow, and 12 native-memory tables, original bytes, guarded owner edits,
workflow Redis and spending state while leaving only PostgreSQL active. Focused
TypeScript/Python tests, Compose wiring, image builds, shell/Python syntax, and
the AST graph refresh pass. The persistent synthetic preview has 12 healthy
containers and no bootstrap container. A raw host `npm test` run is not an
installation fixture: 68 checks passed, 78 environment-specific checks skipped,
and five checks correctly lacked the fixture database/service credentials; the
full isolated installation rehearsal supplies and passes those integration
boundaries. Live Telegram/reset acceptance remains pending.
[PostgreSQL bootstrap evidence](compatibility/results/2026-09-20-postgres-owned-bootstrap.json).

The owner-directed Docker restart on 2026-09-20 retained one Git worktree and
removed only Nocheh-owned Docker state: 47 containers, 40 volumes, 22 networks and
55 old image tags. The deleted volumes included the stopped installation's legacy
PostgreSQL and native-store data; its earlier reset preflight and ownership review
are no longer current. The repository bind-mounted state and saved `.env` still
exist, so this Docker cleanup is not the complete installation reset. The unrelated
`coopr` Compose project remained intact. A full
no-cache build with current pinned bases completed for every declared Nocheh image;
Go dependency downloads now have a checksum-verified secondary proxy, and the
Hermes TUI install has bounded retries plus a persistent BuildKit npm cache. The
standard test entrypoint now creates a temporary state directory and distinct
Compose project with synthetic credentials, runs the backend-termination check
only under its explicit isolated-fixture flag, runs Hermes offline, and removes its
containers, volumes and networks even when a check fails.

The final image refresh passes 107 ordinary service checks with 44 environment-
specific skips, the separately isolated database-loss check, 343 Hermes checks
with three skips, and all 100 reset checks in the read-only management image. The
AST graph refresh covers 498 files with 3,433 nodes and 12,675 edges without model
calls. A repeated internal-only fresh-baseline rehearsal converts a synthetic
legacy setup to the original-only layout, proves archive, derivative, workflow and
Honcho stores empty, retains synthetic setup/accounting, and leaves runtime
activation disabled. The rehearsal cleaned up after itself; the daemon again has
zero Nocheh containers, volumes or networks while the verified images remain. The
live reset and fresh Telegram acceptance gates remain pending.
[Fresh Docker evidence](compatibility/results/2026-09-20-fresh-docker-build.json).

The reset can now start from the installed legacy database and finish on the
required three-store layout. After preservation and erasure, initialization writes
a private layout-transition intent before changing only the saved
`NOCHEH_STORAGE_LAYOUT` selector. Exact source and target configuration hashes make
the write retryable; unrelated configuration changes fail closed. The frozen legacy
security policy, owner/group allowlist, guard mode and custom runtime profiles are
converted into the original-only setup request. Legacy filtered space policies
become enabled filtered sharing rules; approved and isolated policies become
disabled rules that retain their selected sources and privacy instructions without
granting new access. Unrepresentable self-sharing and unknown policy fields require
review. The detailed transition artifact is retired only after the empty-baseline
proof.

Fifteen focused configuration/initialization checks and all 97 reset checks pass on
the host; the same 97 checks pass in the read-only, network-disabled management
image. A complete internal-only Compose rehearsal starts with a real legacy schema,
one original, one generated context, a filtered space policy and a legacy custom
profile; it erases the synthetic content, writes the target layout, restores the
policy/profile into fresh three-store databases, proves every content/cache store
empty, confirms the fixture Telegram boundary, and reaches acceptance mode with
restart ownership disabled. The first rehearsal attempt used the management image
where a runtime image was required, failed before setup, and cleaned up; the repeated
runtime-image attempt passed. No provider or live Telegram request was made. The
live installation is currently stopped and remains unchanged; the later locked
read-only setup/effect audit below supersedes the earlier missing aggregate check.
[Legacy transition evidence](compatibility/results/2026-09-18-reset-legacy-transition.json).

Integrated commit `9fa7f51` now has a fresh installation-scoped, non-executable
preflight bound to the current legacy configuration and exact Docker identities:
17 containers, three volumes, 65 classified paths and zero inventory blockers.
The private ownership review covers all 15 immediate restore/archive items: 12
installation-owned backup, export, restore and recovery entries are selected for
erasure, while three worktree archive/backup entries are preserved as unrelated.
The preflight and reviewed-path artifacts are mode `0600`, copied no content and
remain private under `data/local/admin/reset/`. That preflight did not start the
stopped legacy database. Reset execution, the one-attempt Telegram
boundary, the dedicated test-group/human evidence and fresh acceptance remain
pending. [Live preflight evidence](compatibility/results/2026-09-18-reset-live-preflight.json).

The live preflight retry exposed unstable Docker mount ordering in three otherwise
unchanged container inspections. Reset identity now canonicalizes each container's
set-like mount inventory at every Docker inspection boundary used by planning,
erasure and initialization. Two consecutive live read-only inventories now produce
the same bound identity with 17 containers, three volumes, 65 paths and zero
blockers. All 98 reset checks pass on the host and in the read-only,
network-disabled candidate management image. No live service or data changed.
[Mount-order evidence](compatibility/results/2026-09-19-reset-mount-canonicalization.json).

The locked current-installation audit now verifies the legacy setup aggregate and
effect settlement without exposing content. PostgreSQL alone was temporarily
started with restart ownership suppressed, the maintenance lock and writer check
held, then returned to its saved stopped state and restart policy. The setup has one
configuration record with a stable content-free fingerprint. All 311 outbound
receipts are retained: 283 are delivered and 28 are explicitly ambiguous
`deleteWebhook(drop_pending_updates=false)` polling setup calls. Settlement now
classifies only that exact non-dropping setup operation separately from delivery;
ambiguous sends and dropping webhook operations still block. The live audit has
zero delivery blockers, and all 100 reset checks pass on the host and in the
read-only, network-disabled management image. No receipt was changed or replayed.
[Effect-settlement evidence](compatibility/results/2026-09-19-reset-effect-settlement.json).

The final private reset inputs are regenerated from integrated commit `09e6d7b`:
17 stopped containers, three volumes, 65 paths, zero blockers, and the same exact
15 ownership decisions (12 erase, three preserve). The selected runtime,
management and Hermes image digests are recorded without changing any container.
Read-only Telegram metadata finds one configured group with three members; the
owner and bot are members, the bot can read group messages, and another human is
present. Its title has no test/acceptance/Nocheh signal, so the configured group
cannot be designated as the dedicated acceptance group by inference. Reset
execution remains withheld until the owner designates that group and the other
human can produce the required post-boundary reply/reaction. GitHub authentication
also remains unavailable. [Final readiness evidence](compatibility/results/2026-09-19-reset-live-readiness.json).

The post-reset live gate and controlled resumption are now implemented as separate
internal coordinator transitions. The reset-only validator accepts one closed
`nocheh-fresh-acceptance-v1` request bound to the current reset ID, installation
generation, and exact confirmed Telegram-boundary timestamp. It rejects fixture
labels and verifies current post-boundary rows across all three stores: live owner
and allowlisted-group sources, reply/reaction targets and a non-owner human actor,
selected subscription transcript provenance, active learned memory and its exact
Honcho projection receipt, owner correction, inspected isolation, intentional
silence, one exact approved delivery, one-attempt restart recovery, and the fresh
Honcho verification/ingestion/ready-context receipts. Historical rows cannot pass.
The journal advances only through `fresh_acceptance`; all restart policies remain
`no`. A separately journaled resumption then restores the exact pre-reset policies
only for services that were previously running. Interrupted partial policy changes
resume idempotently and dependency-only jobs remain non-restarting. Four focused
Python checks, all 94 reset checks, two mock store checks, a three-check real
three-database PostgreSQL run, the final candidate build, Compose configuration,
and the full internal-only reset lifecycle pass. No live acceptance request was
fabricated or accepted. The live reset/boundary, dedicated group, human input, and
fresh checks remain required before this code can resume the installation.
[Fresh-gate evidence](compatibility/results/2026-09-18-reset-fresh-acceptance-gate.json).

Fresh acceptance now has a separate, restart-safe activation mode. The coordinator
derives the exact enabled service set and original restart policies from the
immutable quiescence receipt, expands only current Compose dependencies, records
the plan before creating containers, and rejects old/replaced identities or a
changed plan. It creates every fresh dependency while all four reset fences remain,
then forces every container to `restart=no` before releasing only the current
reset's fences and starting services in dependency order. An interrupted start
retries against the same identities; it cannot enable automatic restart, complete
fresh acceptance, or resume production. Two focused interruption/tamper checks and
all 92 reset checks pass. A full internal-only synthetic reset lifecycle reaches
`acceptance_running` with four fresh infrastructure services, one fixture backlog
call, zero provider/live Telegram calls, released fences, and restart ownership
still disabled. The fresh live evidence gate and controlled restoration of saved
restart policies remain pending.
[Acceptance-mode evidence](compatibility/results/2026-09-18-reset-acceptance-mode.json).

The one-attempt Telegram reset boundary is now bound to current empty-state proof
instead of caller-supplied assertions alone. Reset-only store observation computes
content-free fingerprints over every row and sequence in the exact archive,
derivative, and control schemas. Immediately before and after the single transport
call, the coordinator rechecks those fingerprints, zero content rows, exact new
generation, empty Inngest/Honcho PostgreSQL and Redis state, unchanged native
preferences, inactive fences, fresh resource identities, and foreign-writer
exclusion. Dirty state or a changed generation fails before transport. A confirmed
result replays without another call; an uncertain result retains the exclusive
attempt and cannot retry automatically. Four focused checks, all 90 reset checks,
15 protocol checks, a real PostgreSQL rehearsal, the candidate build, and a complete
fixture-transport lifecycle pass. That lifecycle made zero live Telegram/provider
requests and changed no live state. The live boundary, fresh acceptance, and
controlled resumption remain pending.
[Boundary binding evidence](compatibility/results/2026-09-18-reset-boundary-binding.json).

Fresh reset initialization and the empty-baseline gate now pass a complete synthetic
lifecycle. The coordinator records creation intent before making new resources,
rejects every pre-reset container and volume identity, and starts only the selected
PostgreSQL and Redis services with restart ownership disabled. It assigns the
journal's new installation generation, restores only current setup, admits active
custom profiles through deterministic repository operations, and restores bounded
native presentation preferences while every runtime owner remains fenced. The
baseline independently proves zero archive/derivative rows, exact setup-only control
history, empty Inngest and Honcho PostgreSQL/Redis stores, empty original files and
spool, and no foreign writer. It then retires detailed private reset artifacts under
a durable intent. Interrupted startup resumes against the exact recorded resources;
old identities, altered setup/history, dirty caches, or unexpected journal content
fail closed. Three focused checks, all 89 reset checks, a two-check real PostgreSQL
rehearsal, the candidate build, and a full Honcho-enabled internal-network lifecycle
pass. Synthetic provider login, credentials, spending, and inactive fences remain;
runtime activation and live state changes remain absent. The live reset, one-attempt
Telegram boundary, fresh acceptance, and controlled resumption are still pending.
[Fresh baseline evidence](compatibility/results/2026-09-18-reset-fresh-baseline.json).
[Setup admission evidence](compatibility/results/2026-09-18-reset-setup-admission.json).

The scoped erasure phase is now a resumable coordinator primitive bound to the
completed preservation receipt, exact container and volume identities, and the
anchored file manifest. Fsynced intents precede file deletion, database shutdown,
container removal, and volume removal. After the reviewed PostgreSQL service is
stopped, recovery continues without its maintenance connection while rechecking
the journal, preservation artifacts, retained setup fingerprints, inactive fences,
Docker identities, and foreign references. Inngest PostgreSQL and bind-mounted
workflow Redis data are explicit targets. Interrupted file, database-stop, and
volume removal paths resume; changed receipts, recreated same-name volumes,
replacement containers, and foreign mounts fail closed. Eight focused and 86 full
host reset checks pass. The final management image passes 57 reset checks beside
six pinned native checks in read-only, network-disabled Compose. A fresh
internal-network rehearsal removed three synthetic containers, two PostgreSQL
volumes, original/spool data and workflow Redis data while retaining credentials,
provider login, spending, inactive fences, and an unrelated container/volume.
Only `erased` advances; initialization and empty-baseline proof remain separate.
No live installation state was stopped or deleted.
[Erasure evidence](compatibility/results/2026-09-18-reset-erasure.json).

The complete pre-erasure preservation gate now binds the setup-only database
snapshot, saved environment policy, native preference snapshot, exact archive
ownership decisions, sanitized provider accounting, byte fingerprints of retained
credentials/provider login/Honcho setup and spending, and the anchored file-erasure
manifest into one immutable receipt before advancing `preservation_frozen`. Every
input is independently rechecked under the journal, maintenance and inactive
fences. Interrupted cleanup is retryable both before and after its accounting
receipt; changed policy, credentials, preferences, accounting, ownership or erasure
scope fail closed. Eight focused checks and the 78-check reset suite pass. The final
management image passes 49 reset checks beside six pinned native checks in
read-only, network-disabled Compose. A fresh internal-network rehearsal passes with
real PostgreSQL configuration reads and the real SQLite sanitizer: four setup rows,
ten retained roots and five erasure targets were bound; source/derivative canaries
were excluded from all preservation artifacts while original files, credentials,
provider login, Honcho setup and spending remained. The management image now
contains the YAML runtime required by native preference transfer. No live state was
stopped, reviewed, sanitized or deleted.
[Preservation evidence](compatibility/results/2026-09-18-reset-preservation.json).

The reset now requires a private, exact ownership review for every immediate item
under existing restore and external archive roots. Each current device/inode is
explicitly marked installation-owned for erasure or unrelated for preservation;
missing decisions, additions, replacements, unknown file types, changed roots and
forged paths fail closed. The anchored file manifest accepts reviewed erasure only
for direct children of those exact roots and preserves unrelated siblings. Thirteen
focused host checks and the 70-check reset suite pass. The candidate management
image passes 41 reset checks beside six pinned native checks in read-only,
network-disabled Compose with no state mounts. That increment did not review or
delete live files; the later installation-scoped preflight above records the current
private ownership decisions without deleting them.
[Ownership review evidence](compatibility/results/2026-09-18-reset-ownership.json).

The reset now has a bounded setup-only database snapshot for current security
policy, legacy conversation overrides or original-only guard/runtime configuration,
projects, assignments, sharing rules, and active profile identities. It uses one
read-only statement with explicit columns, rechecks maintenance/quiescence and the
inactive fences, and fails if configuration changes before durable publication.
Originals, derivatives, learned state, approvals, workflows, released shares and
configuration history are excluded. Eight host and eight packaged network-disabled
checks pass; a fresh real-PostgreSQL rehearsal passes for both layouts and confirms
seeded source/derivative content is absent. This is one preservation component and
does not advance the complete-preservation phase. Environment/provider setup,
spending, native preferences, fresh-store admission and full orchestration remain
pending. No live state changed. [Configuration snapshot evidence](compatibility/results/2026-09-18-reset-configuration.json).

The offline settlement gate now checks durable native delivery/tool receipts and
workflow/domain correspondence while reset quiescence and database maintenance
remain held. It never resends an action or rewrites an ambiguous database receipt.
Missing/ambiguous external outcomes and orphan uncertain effects block the gate;
stopped local computations remain explicitly result-unknown. Stable, content-free
evidence is durable before the journal advances and can resume after interruption.
Twelve host checks pass; a fresh internal-network Compose rehearsal passes against
both real storage schemas and native capture journals. The final management image
build and 21 packaged settlement/file-erasure checks pass without network access.
An initial synthetic duplicate-dispatch setup error was corrected before the passing
rehearsal. No live settlement, owner shutdown or deletion occurred. Full preservation,
container/volume erasure, initialization and fresh acceptance remain pending.
[Settlement evidence](compatibility/results/2026-09-18-reset-effects.json).

The reset file-erasure primitive freezes metadata-only, installation-local targets
and removes entries through anchored descriptors without following symlinks.
All remaining targets are checked before deletion; changed/new files, replaced
ancestors, hardlinks, special files, and overlaps with preserved setup stop it.
Inactive markers/protected subtrees remain; interrupted deletion resumes from the
same manifest. Nine host checks and nine checks in the final network-disabled,
read-only Compose image pass. The complete management build passes. This is an
internal primitive: the coordinator must bind the manifest into preservation
proof and recheck all barriers. No live files or owners changed. Container/volume
erasure, effect settlement and the full reset remain pending.
[File erasure evidence](compatibility/results/2026-09-18-reset-files.json).

The original-only owner dashboard preview passes learned-memory correction/retirement
with history, project management/topic inheritance, sharing preview/approval/revocation,
and reprocessing/activation preserving prior owner edits and exact source bytes.
Real preview testing found the graph proxy still enriching originals with native
notes; that dependency is now retained only for legacy stores. Original observations
are labeled, counted, filterable, and inspectable in the 3D view. Thirteen focused
Python/graph checks and the full pinned candidate image build pass. The isolated
preview was inspected at 375px/1440px in dark/light themes; keyboard focus restoration
and mobile overflow checks pass. A fresh compatibility follow-up makes Overview read
its original-record and original-file counts from archive storage, exposes the guard
mode, and routes Memory access to current explicit sharing controls instead of the
legacy memory-space API. Three storage/API checks pass without skips, including
database-outage and real entrypoint coverage. The follow-up preview passes at 375px
and 1440px in dark/light themes with no console errors or horizontal overflow. Its
background workers are paused after fixture preparation. Fresh full-pipeline evidence
is the separate G rehearsal below.
[Owner dashboard evidence](compatibility/results/2026-09-18-original-dashboard.json).

The complete synthetic installation rehearsal now passes across the three stores,
Hermes, Honcho, Inngest, guard preparation, convention/reaction learning without
acknowledgments, browser execution, delivered-message capture, duplicates, and a
combined database/workflow outage. Capture/control recovered first; native memory
recovered in 249.077 seconds within the 300-second bound. Fixture canaries reached
only the detector; no external provider calls or live state changes occurred.
API/capture and workflow pools are separate, ordinary Connect concurrency is four,
and publication backoff counts consecutive transport failures rather than prior
successful receipt probes. Thirteen focused checks pass without skips; the prior
image fails the retry-delay regression. The complete candidate image builds.
[Installation recovery evidence](compatibility/results/2026-09-18-installation-recovery.json).
This is deterministic fixture evidence, not live recall/model-quality acceptance.
Full reset orchestration, fresh live gates, and remote synchronization remain pending.

First guarded-copy publication no longer blocks unrelated authorized contexts.
Its own source still fails closed until its prepared pointer is ready; replacement
guards, engine selections, and learned publications retain their authorization
barriers. An injected-interruption regression fails on the previous candidate;
18 affected storage/action/runtime checks pass with the fix and no skips. The
complete candidate management image builds successfully. Its initial combined
rehearsal timed out after capture/control recovery; the subsequent capacity and
retry fixes below have a fresh passing rehearsal. No live state or owners changed.
[Guard publication evidence](compatibility/results/2026-09-18-guard-publication-isolation.json).

Reset shutdown coordination now preserves each reviewed container's prior running
state and restart policy before suppressing restart ownership. It installs durable
inactive fences, stops capture/native scheduling before host executors and other
writers/refresh owners, and leaves database/cache servers available for effect
settlement. Interrupted shutdown resumes from the same receipt; changed ownership,
foreign writers, lost maintenance, and replaced fences block progress without
automatic resumption. Thirty-one focused shutdown/journal/inventory checks pass.
A fresh Compose rehearsal with nine owned containers and real PostgreSQL maintenance
exclusion passes, including injected interruption, a late foreign writer, eight
stopped heartbeat writers, retained settings, and an untouched separate sentinel.
These are synthetic lifecycle checks, not full native/provider acceptance. No live
owner was stopped. Effect settlement, preservation/erasure orchestration, combined
installation rehearsal, and fresh live gates remain pending.
[Shutdown evidence](compatibility/results/2026-09-18-reset-quiescence.json).

Reset progress and the one-attempt Telegram backlog boundary are implemented as
internal coordinator primitives. Ordered evidence, installation identity, and a
new generation bind the durable journal. The backlog call requires the empty
baseline and inactive fence; an exclusive durable reservation prevents duplicate
requests even across macOS/Docker lock domains. Confirmed outcomes replay locally;
lost responses, interrupted intent writes, and unconfirmed outcomes stay pending
without retrying the discard. Normal native restart continues preserving updates.
The final management image build and isolated network-disabled Compose run pass:
28 reset/accounting/inventory checks and seven pinned native capture/restart checks,
with no skips. The initial fixture attempt stopped before tests because its tmpfs
options needed YAML quoting; the corrected fresh run passes. AST-only Graphify
contains 459 files, 2,916 nodes, and 11,536 edges with zero model calls.
[Reset protocol evidence](compatibility/results/2026-09-18-reset-protocol.json).
The read-only live audit found two historical ambiguous dispatches and one
ambiguous sandboxed shell action (also represented by one workflow receipt).
Neither dispatch has a matching retained outbound intent; the shell retains an
ambiguous outcome. These are observations for reconciliation after quiescence,
not successful execution evidence or permission to erase their receipts.
The complete reset executor, combined installation rehearsal, and fresh live
acceptance remain pending. No live Telegram request or reset has occurred.

The reset preflight now enumerates exact installation paths, container identities,
and configured PostgreSQL/Honcho/Redis volumes without stopping services or copying
content. It checks both running and stopped containers for shared volume/state
ownership, verifies Compose origin/mount bindings, and flags unknown paths and
symlinked preservation targets. `./scripts/nocheh reset plan --output FILE` writes a
private, explicitly non-executable inventory; frozen preservation and execution
gates remain separate. Seven focused checks pass. The read-only installation audit
identified 17 containers, three volumes, and 63 path dispositions with no ownership
conflicts. Existing restores and external backup/export directories still require
per-item ownership review. [Inventory evidence](compatibility/results/2026-09-18-reset-inventory.json).

The reset's provider-accounting cleanup is a verified candidate. The installation
audit found that the monitor mixes accounting with raw failure bodies, response
metadata, inspection logs, and search text. The pinned-schema cleanup preserves
retained accounting/configuration rows and cache-accounting hints, erases content
fields and execution logs, rebuilds search, and removes old SQLite pages/WAL data.
It uses the monitor's native writer lock and rejects unknown schemas before writes.
Six offline checks pass, including interrupted transactions and preservation
mismatch rollback. A separate network-disabled Compose rehearsal passes against
the real pinned monitor before and after restart, preserving pricing, usage, saved
settings, and the separate spending ledger. No live data was changed and no content
backup was created. [Accounting reset evidence](compatibility/results/2026-09-18-reset-accounting.json).
The full reset coordinator, installation rehearsal, deletion, and fresh live gates
remain pending.

Saved runtime preference transfer is a verified candidate. It captures the eight
supported native preferences, preserves global/profile inheritance, maps legacy
owner profiles to stable control identities, and retains absent topic overrides
so topics continue inheriting their group. Original-only catalogs remain the
authority for custom profiles. Configuration drift, ambiguous names, symlinks,
unadmitted profiles, retained target history, and conflicting partial restores
fail before writes. Exact interrupted writes can resume. The transfer excludes
prompts, native notes/sessions, credentials, and erased schedules' overrides.
Ten offline pinned native checks and the candidate image build pass; Graphify was
refreshed using ASTs only. [Preference evidence](compatibility/results/2026-09-18-runtime-preference-transfer.json).
Connecting this library to the scoped reset coordinator and verifying that full
procedure remain pending. The session's missing temporary worktree was restored
from its committed branch; no installation data was touched.

Browser completion recovery and media-generation handover are verified candidates.
The dashboard pages current authorized missed results four at a time, renders them
before acknowledgment, and retries opaque receipts through outages. Archive
observations retire delivered offers; reads and native emissions alone do not.
The native gateway initializes sidebar publication and switches history reads to
an authenticated completed run's current guard generation without copying old
notes/history or discarding accepted next attachments. Five PostgreSQL/client/HTTP
checks and 35 offline pinned native checks pass. The image build and isolated React
preview pass, including 375px light/dark layouts, profile switching, receipt replay,
and keyboard focus after dismissal. Host-mounted native startup timeouts were
replaced with a passing image-based run; they are not counted as passes.
[Browser recovery evidence](compatibility/results/2026-09-18-browser-recovery.json).
The combined Compose/native/browser rehearsal, saved preference migration, scoped
reset manifest/execution, and fresh live gates remain pending.

## Original-only archive and clean restart — 2026-09-18

The owner authorized implementation of the [complete execution plan](docs/original-only-archive-plan.md).
[ADR-0053](docs/adr/0053-original-only-archive.md) supersedes guarded placement in
ADR-0052. Requirements now classify original audio/video/files as sources, all
guarded versions and generated output as derivatives, and policy/workflows as
control. Three databases, automatic inspectable contextual learning, corrections,
projects, and explicitly managed sharing are accepted requirements.

| Increment | Status |
| --- | --- |
| Requirements, decision, and reset procedure | Complete; structure, local links, consistency, coverage, and diff hygiene checked |
| Three stores, repositories, capture handoff, role isolation | Repository and production-composition candidates verified in isolated Compose; live installation remains on its saved layout |
| Guard/control separation and recovery | Focused checks and fresh combined outage rehearsal pass; no live cutover |
| Derivative versioning, reprocessing, portability, backup | Versioning/owner interfaces, source and derivative portability, native transfer, and coordinated backup/inactive restore have recorded candidate evidence; live cutover and fresh live gates remain separate |
| Replies/reactions, Honcho provenance, learning, projects, owner interfaces | Repository/owner checks and deterministic native learning rehearsal pass; fresh human reaction and real reasoning/recall gates remain pending |
| Complete isolated Compose and UI acceptance | Combined Compose rehearsal passes with deterministic providers; principal owner flows, Overview and Memory access compatibility verified in isolated previews |
| Installation-scoped reset and empty baseline | Preservation, scoped erasure, legacy-to-three-store conversion, setup/native preference restoration, and complete empty-baseline proof pass a combined synthetic lifecycle. A current private preflight and exact ownership review have zero inventory blockers; reset execution remains pending |
| Fresh live acceptance and saved-setup resumption | Current-state validation, live-only evidence verification, and exact saved-policy resumption are implemented and pass isolated failure/recovery tests. The live boundary, dedicated test group, human participation, fresh evidence, and actual resumption remain pending |

Preserve configuration, external logins, and spending accounting during the
authorized reset; erase installation-owned content, history, backups, and exports.
Implementation has not changed live services or data. Earlier
storage/classification and convention-design questions below are resolved by the
accepted plan; those entries are historical observations, not remaining decisions.

The storage foundation adds separate database/owner/runtime roles, append-only
source and derivative repositories, immutable original file manifests, typed
provenance, and recoverable handoff into the existing Inngest registry/outbox.
The spool commits its bounded archive batch before attempting control writes;
reconciliation cycles through all capture sequences to handle commit reordering.
Concurrent reconciliation uses one control transaction without borrowing a
second connection while holding the cursor lock. No cross-database joins,
foreign tables, or mixed-store query router are introduced.

Node 24 compilation and the initial clean development image build pass. Both
storage tests pass against three actual databases, including wrong-role access,
original/derivative rewrite denial, control outage, duplicate capture, interrupted
handoff, concurrent reconciliation, version provenance, and repeat bootstrap.
The existing suite initially reports 92 passes, two missing-native-dependency
failures, and one container-only skip. After starting synthetic Inngest/Redis and
configuring loopback aliases, all eight affected/storage/container checks pass;
this covers all 95 distinct checks without treating the initial failures as passes.
The unsupported host-only run is not acceptance evidence. Graphify was refreshed
with ASTs only: 306 files, 1,873 nodes, 6,743 edges, zero model calls.

The fixture project is `nocheh-stores-20260918`, with its own internal network,
database volume, synthetic credentials, and no published ports, live poller,
scheduler, OAuth authority, or live data. Production still uses the legacy
single-database path: this increment is a tested foundation, not a completed
storage cutover. Reset, guard migration, reprocessing activation, learning/UI,
portability, and fresh live acceptance remain pending.

Generated capture now uses installation-bound control operation references and
durable derivative content, so prompts and schedules require no invented archive
event. The spool classifies outbound results before touching control: confirmed
Telegram Message responses become original evidence, while intents, responses,
uncertain effects, and generated inputs remain outside the archive. Boolean or
message-ID-only responses cannot turn a draft into observed speech. Control
receipts retain references and effect state; replay reuses the immutable output.
Guarding accepts operation-rooted derivatives, while source-version activation
rejects them. No new delivery or retry of an external effect occurs in this path.

Four affected real-PostgreSQL checks pass; the final generated-capture pair also
passes after adding the activation rejection. Compilation and AST-only Graphify
pass (337 files, 2,051 nodes, 7,572 edges, zero model calls).
[Generated capture evidence](compatibility/results/2026-09-18-generated-capture.json).
Production service routing, attachment preparation, and the remaining owner and
runtime interfaces still require integration before the isolated full rehearsal.

Attachment and preparation repositories now separate immutable manifests from
download attempts/backoff. Original bytes are fsynced before manifest commit and
control completion; interrupted completion repairs from the existing bytes without
downloading again. Imported files wait for owner uploads. The preparation step
uses the existing workflow family fence and versioned reprocessing/selection for
subscription transcripts, UTF-8 extraction, and explicit unsupported-file results.
Automatic preparation cannot replace an existing selection or an owner's guard edit.
Four affected synthetic PostgreSQL checks pass, including wrong-epoch admission,
file mutation denial, interrupted receipt recovery, backoff, text/binary handling,
and repeated preparation. Production workflow handlers still await the common
service composition; no live transcription or full rehearsal is claimed.
[Preparation evidence](compatibility/results/2026-09-18-store-preparation.json).

The source retrieval repository now searches original evidence only, reads active
authorized file derivatives separately, and links source details to version history.
Its owner graph contains originals, attachments, actors, and observed relationships;
old reply/reaction targets resolve independently of the page. Scoped reads strip
embedded reply snapshots and check target access independently, including unknown
topic denial. Capability claims carry installation generation as well as epoch;
the new repository rejects legacy or stale claims even with guarding off. The old
runtime routes are not switched by this increment.
Six affected synthetic/retrieval/HTTP checks pass; the final targeted rerun also
passes after adding final source-access rechecks and repeatable fixture identities.
AST-only Graphify: 343 files, 2,083 nodes, 7,773 edges, zero model calls.
[Source retrieval evidence](compatibility/results/2026-09-18-source-only-retrieval.json).

The shared storage-service composition now exposes a tested owner HTTP controller
and CLI commands for source versions, exact provenance, idempotent reprocessing,
guarded activation/history/restore, learned correction/retirement/history, project
management and membership, sharing-rule management, and bounded Honcho provenance.
The existing dashboard owner proxy recognizes these routes, preserves its session
and cross-site checks, and reports revision conflicts. Source/learned mutations
reject scoped tokens before reading their bodies. Six affected HTTP/PostgreSQL
and management checks plus five Python CLI checks pass. Production API mounting,
sharing content previews/releases, and visible UI remain pending.
[Owner operation contracts](docs/storage-owner-api.md) and
[owner API evidence](compatibility/results/2026-09-18-storage-owner-api.json).

Runtime-context preparation now persists generated inputs and detector checkpoints
in derived storage, with typed source or scheduled-operation roots. Authorized
prepared passages survive formatting; caches are isolated by audience, purpose,
installation generation, and guard epoch. Detector results survive a lost cache
completion, and completed batches persist atomically before guard publication.
Guard-off still checks the bound source and current audience. Internal guard
results cannot become active source derivatives or archive records. All eight
affected PostgreSQL and prepared-context checks pass after correcting one test's
expected detector rejection code. Runtime broker wiring remains pending.
[Context evidence](compatibility/results/2026-09-18-store-prepared-context.json).

The broker accepts explicit turn/audience/file repositories and writes policy
decisions to control storage with typed original/operation references. Native
profile identity includes installation generation, audience, purpose, and guard
epoch. Scheduled turns need durable admission and become unusable after closure;
source turns require exact known conversation membership. Provider attempts and
streamed output recheck authorization. Administrative guard requests now keep
their generated context in derived storage under control operation roots. Six
affected broker, action, and security-policy checks pass; the prior four context
and broker checks also pass. An initial fixture omitted attachment preparation
and correctly failed closed; it was corrected. AST-only Graphify: 353 files,
2,133 nodes, 8,096 edges, zero model calls. Production entry points still await
the full service cutover.
[Broker evidence](compatibility/results/2026-09-18-store-security-broker.json).

The candidate Honcho repository now queues permitted source/relationship packets
and learned projections with content in derived storage and receipts in control.
Each receipt records all source references, guard/selection dependencies, audience,
generation, and immutable input hash. Writes become uncertain before the native
mutation; recovery reconciles exact native messages and never treats absence as
permission to resend. Retired receipts can be settled without reactivating their
workspace. Native representations and recall results persist before completion,
carry explicit citation limitations, and are guarded through the current prepared
context boundary so owner-approved passages remain exact. Corrections invalidate
old generations and rebuilt inputs include the current owner interpretation.

Eight affected synthetic memory/guard checks pass, followed by two targeted
checks after adding multi-source ancestry coverage. Earlier fixture failures were
unknown forum membership, a null-prototype assertion, and generation isolation;
they were corrected without relaxing runtime checks. TypeScript and AST-only
Graphify pass (355 files, 2,162 nodes, 8,253 edges, zero model calls). No native
provider request or live acceptance was performed. Production workflows, Hermes
review/profile integration, and the full service cutover remain pending.
[Native memory evidence](compatibility/results/2026-09-18-store-native-memory.json).

Hermes native review now has a separate control job repository and durable derived
inputs/results. Profile-busy responses preserve identity and consume no attempt;
uncertain work only observes the same native receipt. Completed results repair a
lost control write without another native call. Owner pause/resume uses revisions
and cannot turn uncertainty into a new execution. Review capabilities are verified
before opening a native profile; an owner-only review may use permitted source
evidence in the private owner profile, while an ordinary turn cannot use that
exception. Reviews and foreground owner turns share their native notes/quiet-period
lock; filtering has a separate context, and prepared caches retain purpose isolation.

Native profile names and recall filtering now include installation generation.
The original-only layout rejects legacy unbound credentials. Three affected real
PostgreSQL checks pass, followed by two final purpose-boundary checks. Twenty-one
offline tests pass in pinned Hermes `7166071f`, with no network or installation
state. A temporary-filesystem fixture syntax error prevented the first container
from starting and was corrected. AST-only Graphify: 357 files, 2,178 nodes, 8,347
edges, zero model calls. Native management/managed turns, workflow routing, and
production entry points still await their remaining migrations.
[Native review evidence](compatibility/results/2026-09-18-store-native-review.json).

Explicit sharing now keeps preview inputs, filter results, published text, and
private source provenance in derived storage; control stores policy and publication
receipts. Owner API/CLI operations list previews/releases, inspect provenance,
approve an exact text hash and guard revision, and revoke with revision checks.
Scoped readers receive only the released representation, without private source
identifiers. Rules select exact source/destination conversations; unknown topics
cannot broaden access. Project membership never grants source access.

Filtering uses the existing native subscription adapter, records its actual model
and provider configuration, and checkpoints results before completion. It searches
original messages and selected transcripts/extractions. Changed source guards,
selected engine versions, output guards, or sharing rules withhold affected results;
revocation invalidates existing contexts before policy becomes usable. Retried
approvals cannot revive revoked releases. Filter candidates remain untrusted data,
and malformed results cannot add administrative fields or private citations.

Three affected PostgreSQL checks, four CLI checks, and two offline native filter
checks pass. Recovery covers a lost completion receipt without another model call,
plus revocation during filtering and engine activation after sharing. TypeScript,
diff hygiene, and AST-only Graphify pass (361 files, 2,219 nodes, 8,563 edges,
zero model calls). No live credentials, provider calls, or installation state were
used. Dashboard and production routing remain pending.
[Sharing evidence](compatibility/results/2026-09-18-store-sharing.json).

The candidate dashboard now provides learned-memory inspection, evidence links,
conflicts, corrections, retirement/restoration, and immutable history; project
creation/editing/archive and topic inheritance/exclusion; and sharing rule,
preview, exact approval, provenance, and revocation controls. Source details keep
immutable originals first and show file readings by default, with an explicit
internal-derivative view. Reprocessing, prepared activation, guarded owner edits,
and revision history use the separated owner API. Revision conflicts retain drafts;
uncertain retries retain their operation IDs while the form is open.

The separate `nocheh-stores-ui-20260918` Compose project exposes only
`127.0.0.1:18859`, uses its own database volume and synthetic credentials, and runs
no provider, poller, scheduler, native learning, or credential refresh. Browser
checks cover corrections/retirement/restoration, project/topic operations,
approved/filtered previews and revocation, rejected out-of-scope sources, two
transcript versions and retained owner edits, desktop/mobile light/dark layouts,
keyboard dismissal/focus return and long-panel focus visibility. No horizontal
page overflow was observed at 375px. The browser console is free of warnings/errors.

Three affected PostgreSQL tests and fourteen existing dashboard checks pass
across the recorded runs. The host socket-boundary test initially failed with
`EPERM`; its isolated-container rerun passes. Initial preview port publication
and keyboard-focus defects were fixed and checked again. TypeScript, production
build, diff hygiene, and AST-only Graphify pass. This verifies candidate owner
interfaces, not complete production Compose acceptance or fresh live gates.
[Owner dashboard evidence](compatibility/results/2026-09-18-store-dashboard.json).

Version-6 recovery tooling now snapshots all three databases while holding their
write barriers through file and native-store capture. A PostgreSQL maintenance
lock serializes coordinators before service changes; lost coordination leaves
writers stopped. It stops the installation’s
Compose writers and rejects orphan containers with writable state mounts. Snapshot
checksums, per-table fingerprints, and sequence positions are validated; partial
barrier failures release earlier locks. Restore requires absent databases/roles,
verifies exact data before advancing the guard epoch, disconnects native memory,
and leaves runtime roles NOLOGIN. The three-store restore path starts no application,
provider, scheduler, or executor. Saved logins remain in inactive restore locations.

Twenty-three focused/existing Python recovery checks pass. Real PostgreSQL fixture
recovery verifies 7 archive, 13 derivative, and 34 control tables; 88 synthetic
owner-edited guarded revisions survive restore and restart. No live data or provider
was used. Coordinator ordering/file checks are tested with fixtures; the complete
native/Compose recovery rehearsal remains pending production composition, as do
source-only/complete portable exports and imports. This is a verified recovery
increment, not completion of portability or release acceptance.
[Three-store recovery evidence](compatibility/results/2026-09-18-store-recovery.json).

Source-only portability is now implemented in the candidate repositories and
owner API/CLI. `nocheh-sources-v1` preserves original envelopes, wire bytes,
timestamps, typed source references, manifests, and binary/empty files. It contains
no derivative or guarded records. Package integrity is checked before CLI import;
an incomplete/corrupt export is not marked complete. Paginated exports remain
distinct from coordinated backups.

Control intake records preserve the distinction between imported history and live
arrival without changing the observation's original provenance. Source import
requires durable admission before archive commit; ordinary capture retains its
archive-first outage behavior. Bounded reconciliation repairs interrupted imports
without old Telegram dispatch, automatic memory learning, or provider file fetches.
Owner learning consent is explicit and separately revisioned. The new source-only
path rejects complete bundles rather than dropping derivative/guarded history.
Complete portable exports/imports, legacy bundle routing, and production entrypoint
activation remain pending.
Five affected PostgreSQL checks and twelve Python portability/archive checks pass;
TypeScript and AST-only Graphify pass. All data used by these checks is synthetic.
[Source portability evidence](compatibility/results/2026-09-18-source-portability.json).

Derivative transfer now has a fixed-format owner API and a Python transfer library.
It preserves immutable outputs/provenance, guarded inputs and owner history,
selection history, learned revisions, and exact imported records. Historical
operation roots are marked imported and cannot authorize execution. Imported
prepared caches and guard fragments remain inspectable history without entering
active preparation tables. Imported selections and learned projections stay
unavailable to runtime readers even with guarding off. Normal explicit owner
restoration/activation/correction makes reviewed content usable with revocation.
Duplicate imports cannot replace later destination edits or choices.

The real PostgreSQL round-trip uses empty, isolated namespaces in all three
fixture databases with their actual domain roles. It verifies binary originals,
two transcript engines/versions, owner-edited guards, selection and learned history,
generated-context lineage, inert same-generation/epoch caches, and explicit owner
adoption. Eleven affected PostgreSQL/Node checks and fifteen Python checks pass;
TypeScript and AST-only Graphify pass. No live provider or installation data is used.
Top-level coordinated portable bundles, native Honcho transfer, legacy import
conversion, production wiring, and full inactive native round-trip remain pending.
[Derivative transfer evidence](compatibility/results/2026-09-18-derivative-portability.json).

Three-store installation configuration and setup are now implemented as an opt-in
Compose overlay selected by saved configuration. Setup-only bootstrap provisions
the three domain stores plus Inngest, holds the installation maintenance lock,
preserves existing generations/history on repeat setup, and refuses inactive
restores. Domain, administrator, and workflow credentials are distinct and private.
Runtime app/security configuration removes administrator and Inngest database
passwords; Hermes receives no domain credentials. The runtime pool factory uses
explicit role/database pairs and rejects bootstrap credentials. Legacy database
initialization fails closed when the new layout is selected.

The Compose render check starts no services and uses temporary synthetic setup.
Two configuration checks, the real-database bootstrap check, and an affected owner
API check pass across the recorded runs. Twenty-four Python configuration,
settings, container/lifecycle, and recovery checks pass; TypeScript and AST-only
Graphify pass. Production main/security/worker entrypoint migration is still
pending; the opt-in layout is not yet a runnable release candidate and the live
installation remains on its prior layout.
[Storage setup evidence](compatibility/results/2026-09-18-store-configuration.json).

The application and security entrypoints now select explicit three-store services
for the original-only layout, with legacy startup isolated behind the legacy
selection. Owner/source/guard/memory HTTP routes use the separated repositories;
HTTP capture acknowledges only an fsynced spool record and continues through
archive/control outages. Independent capture, control handoff reconciliation,
guard reconciliation, outbox publication, and heartbeat stages respect inactive
restore state. Security sees that marker through a read-only mount. Configured
guard mode must be established before scoped requests proceed, and native recall
receives the current installation generation and epoch.

Seven affected real PostgreSQL/HTTP/entrypoint checks pass, including actual app
and broker subprocess startup without administrator credentials, inactive-restore
refusal, outage recovery, exact-once source capture, stale capability denial,
owner operations, and generated-record placement. A prior failed run exposed a
generated-capture test's reliance on the previous fixture guard mode; the test
now sets its own guard-on prerequisite and the complete affected run passes.
TypeScript, synthetic Compose rendering, and AST-only Graphify pass. Workflow
execution, action/managed-runtime endpoints (including action security preview),
complete portable coordination, full Compose rehearsal, reset, and fresh live
acceptance remain pending. No live installation configuration was changed.
[Service entrypoint evidence](compatibility/results/2026-09-18-store-entrypoints.json).

The separated application now registers preparation, reprocessing, native Hermes
review, Honcho ingestion/context, and contextual learning with the existing
Inngest engine. Only metadata crosses its event/step boundary. Two concurrent
domain operations leave pool capacity for nested publications. Bounded refresh
sweeps persist their cursors together with deterministic source/projection
requests. Unknown reaction targets wait for independently captured context;
learning itself performs no delivery or action. Uncertain native effects continue
observation under their original identity instead of being re-executed.

Native memory work revisions create a fresh observation job when new receipts
arrive after an earlier observation completed. A concurrent receipt invalidates an
older readiness check. The capture worker now reconciles pending guard, derivative
selection, and learned-memory publications, including after an interrupted owner
activation. Nine affected synthetic PostgreSQL/engine/process checks pass;
TypeScript and AST-only Graphify pass. Tests invoke the actual workflow step engine
with deterministic native adapters; a complete running Inngest/native installation
rehearsal remains pending. Telegram dispatch, actions, browser/scheduler and owner
workflow controls still require migration. No provider calls or installation reset
were performed.
[Workflow integration evidence](compatibility/results/2026-09-18-store-workflows.json).

Saved assistant setup is now admitted as a versioned control record before scoped
runtime use. The application startup writer publishes an allowlist or guard-mode
change, revokes prior capabilities, and queues refreshes atomically. Repeated or
reordered equivalent setup does not change authority; returning to an older
policy creates a new revision and epoch. Security, scoped HTTP, native memory
preparation, and workflow execution reject stale service configurations. This
keeps a previous service process from using the former allowlist after a change.

Six affected synthetic PostgreSQL/service/workflow checks pass, including lost
refresh-write rollback and concurrent equivalent setup. The focused configuration
check was repeated after the final clean TypeScript build. AST-only Graphify and
documentation checks pass. This adds no conversational configuration authority,
does not activate the candidate installation, and leaves fresh live gates pending.
[Runtime configuration evidence](compatibility/results/2026-09-18-runtime-configuration.json).

Telegram proposals and immutable delivery results now use derived storage; exact
owner decisions, fingerprints, execution metadata, and security audits use control.
Owner HTTP decisions and independently captured owner-DM commands share the same
idempotent approval path. Group conventions and memory-review credentials cannot
approve or request an external effect. These operations create no archive events.
The actions workflow preserves a completed derivative before control completion,
repairs an interrupted completion from that derivative, and observes uncertain
native sends without resubmitting them. The native sender rechecks the current
exact approval, guard binding, admitted configuration, and security policy before
sending; an existing unconfirmed native intent cannot send again.

Five affected synthetic PostgreSQL/service/workflow checks and six pinned offline
Hermes checks pass, with TypeScript and AST-only Graphify. The first native run
caught an action fence inserted into the dispatch block; it was corrected and the
full affected native run repeated successfully. Telegram dispatch integration,
broader controlled tools, managed runtimes, full rehearsal, reset, and fresh live
acceptance remain pending. No live sends occurred.
[Telegram action evidence](compatibility/results/2026-09-18-store-telegram-actions.json).

Telegram dispatch now runs through the separated workflow composition. It admits
only captured live incoming messages, waits for current preparation, and stores
immutable runtime inputs/results in derived storage with control references and
receipts. Original routing IDs remain authoritative even when the owner edits
guarded content. Media enters the committed native handler as prepared text and
selected file readings, avoiding a second native download or transcription.

Lost start acknowledgments observe the same native identity; explicit absence or
a never-started queued request can reuse that identity only after authorization
checks. Revoked queued contexts are cancelled. Completed derivative receipts
repair interrupted control completion, and terminal silence/failure/ambiguity
cannot automatically start another turn. Owner-DM action commands are wired to
this dispatch path; edits/reactions continue learning without dispatching old
replies. Seven affected synthetic PostgreSQL/HTTP/engine checks and eleven pinned
offline native gateway/receipt/scope checks pass. TypeScript and AST-only Graphify
pass. An initial fixture run rejected a malformed workflow run ID; after correcting
that fixture, the focused and combined runs pass. Full Inngest/native rehearsal,
broader tools, managed execution, portability coordination, reset, and live gates
remain pending.
[Telegram dispatch evidence](compatibility/results/2026-09-18-store-telegram-dispatch.json).

Source learning consent is now exposed through owner-only GET/POST API and
`sources learning-consent` / `sources set-learning` CLI operations. The effective
permission distinguishes capture policy from explicit owner decisions. Grants
and revocations use revision checks and idempotent operations; they revoke prior
contexts and queue memory refresh atomically. Scoped callers cannot submit a
consent body. Two affected real-database owner/source-portability checks and five
Python CLI checks pass, with TypeScript and AST-only Graphify. This exposes the
existing consent boundary without enabling imported-source replies or effects.
[Learning consent evidence](compatibility/results/2026-09-18-source-learning-consent.json).

Workflow list/detail, health, metrics, and receipt-aware owner retry/cancel routes
now use a control-only observation view. No archive or derivative SQL joins are
needed to inspect orchestration, including while Inngest is unavailable. Pending
Telegram cancellation survives capture reconciliation; guarded action approval
can be cancelled before execution. Family locks, active-step checks, revisions,
and effect receipts prevent unsafe controls. Retry retains the domain execution
identity and publishes a new orchestration request. Unmigrated domain controls
are not advertised. Legacy owner-migration requests explicitly report that they
do not apply to a fresh original-only installation.

Eight checks pass across separated workflow ownership, service and dispatch tests,
existing legacy workflow ownership/metrics regressions, and inspection boundary
parsing. The pinned running Inngest UI test was skipped because its opt-in fixture flag
was not enabled for this run; that browser/runtime gate remains pending.
TypeScript and AST-only Graphify pass. The initial TypeScript run flagged nullable
fixture list entries; the assertions were fixed before the combined verification.
Managed runtimes, host tools/import coordination, full portability, full rehearsal,
reset, and live acceptance remain pending.
[Workflow owner evidence](compatibility/results/2026-09-18-store-workflow-owner.json).

Controlled shell, browser, and MCP proposals now retain immutable generated
arguments and guarded history in derived storage. Control rows contain typed
references, exact fingerprints, owner decisions, and bounded permissions.
Approval and grant operations use revision checks and idempotency receipts;
guard changes invalidate the proposal even with guarding off. Policy previews
consume no permission and owner inspection retains the originally reviewed
arguments after a later guarded edit. The owner HTTP routes and existing native
proposal route use these repositories. Six affected real-PostgreSQL, HTTP, and
legacy security checks pass. Host claim/start/result execution and owner-DM tool
commands remain pending; this increment performs no tool execution.
[Controlled proposal evidence](compatibility/results/2026-09-18-store-controlled-proposals.json).

Host tool claim/start/result routes now use separated repositories and the existing
Inngest host coordinator. A claim releases exact guarded arguments once; start
rechecks the workflow lease, owner epoch, guard generation, security policy, and
permission revocation. Expired claims become ambiguous and cannot be executed
again. Immutable derived results precede control completion; replay repairs a lost
completion and a retained late receipt can settle an uncertain workflow without
new execution. Workflow inspection and cancellation include admitted tool jobs.
Host Connect transport rejects inactive installations. Import admission remains
closed until its separate repository migration is implemented.

Seven affected PostgreSQL/HTTP/workflow checks and eight offline native executor
checks pass. The first database run had one incorrect expectation that replaying
an identical owner command should reject; its idempotent receipt correctly left
the ambiguous action unchanged. The corrected test additionally checks that a new
approval cannot revive it. This is synthetic receipt verification, not a live
tool-effect or full Connect installation acceptance pass.
[Controlled execution evidence](compatibility/results/2026-09-18-store-controlled-execution.json).

Telegram action review now combines message and controlled tool proposals. Owner
DM commands can inspect exact arguments, approve or deny a bounded proposal, list
permissions, and revoke a permission. Their authority is the independently
captured original owner DM; group commands, imported commands, edited messages,
and editable guarded text cannot authorize them. Decision receipts link to that
original source in control storage. Replays remain idempotent and large tool
arguments require complete review in Activity. Generated replies remain derived
until confirmed delivery is captured. Five affected synthetic checks pass.
[Owner command evidence](compatibility/results/2026-09-18-store-action-commands.json).

Managed turn capabilities now carry the admitted logical profile. The broker
rejects omitted or substituted profile claims, and named profiles in one audience
have different native identities and prepared-text caches. TypeScript and Python
derive the same identity. Default owner/group profiles retain their shared native
identity across transports; owner reviews still share the default owner's notes.
New native generations inherit their named profile's preferences without copying
old notes into an unprepared context. Five affected repository checks, five token/
broker regression checks (including one repeat), and twelve offline native checks
pass. A test-only optional-property typing error was corrected before final
compilation and the targeted regression run. Managed browser/scheduler routes and
native administration still require migration before installation acceptance.
[Managed profile evidence](compatibility/results/2026-09-18-store-managed-profiles.json).

Browser submission capture now persists exact original file bytes before fsyncing
the original observation, without depending on any database or Inngest. Replay
commits the source and its attachment manifests together, then retires the spool
only after deterministic control handoffs. Logical profiles form part of source
identity, so identical conversation/submission IDs in different profiles cannot
collide. Generated browser/scheduled results and triggers are rejected by archive
validation and constraints. Source-only exports retain the original manifests.
Five initial affected checks and four final checks (including three repeats) pass
in isolated Compose, with TypeScript and AST-only Graphify passing. Managed
execution admission remains the next integration step; capture starts no run.
[Browser capture evidence](compatibility/results/2026-09-18-store-browser-capture.json).

Browser admission, claims, leases, cancellation, workflow inspection, and receipts
now use control storage; prepared inputs and terminal results use derived storage.
The admitted source, conversation, logical profile, installation generation,
guard revision, and workflow owner remain bound throughout the run. Claim is
exclusive; observation precedes any same-identity native continuation. A missing
receipt after claim cannot authorize another execution. Completed derivatives
repair interrupted completion without a native call. Cancelled/expired contexts
cannot reuse capabilities or stream protected output, while separately authorized
background review/filter work can still process the original evidence.

The trusted native handoff verifies the signed logical profile before entering
the common runner. Browser topics use exact observed membership for retrieval and
learning. Imported derivative history now carries an immutable inactive-origin
flag; browser, action, learning, guard, and reprocessing recovery cannot mistake
an imported artifact for a locally completed operation. Owner adoption of imported
guard edits and selected transcripts remains available.

The final serial batch passes ten affected PostgreSQL/HTTP checks; seven additional
checkpoint/portability checks passed in the preceding batch. Eighteen offline
native checks pass. An initial fixture reused the same submission ID when testing
session contention and was corrected. A later overlapping pair of fixture batches
caused a `guard_transition_pending` failure; the affected checks were repeated
serially and pass. TypeScript, diff hygiene, and AST-only Graphify pass (417 files,
2,551 nodes, 10,264 edges; zero model calls). Native profile administration,
confirmed browser delivery capture, scheduler migration, and full installation
acceptance remain pending. No live service or content was changed.
[Browser execution evidence](compatibility/results/2026-09-18-store-browser-runs.json).

Native profile configuration now has a control repository and owner-only list,
resolve, create, rename, and retire endpoints. A custom profile keeps its stable
configuration/preference identity across rename; native directories remain bound
to the installation and guard revision. Renaming/retiring atomically revokes old
contexts, retired identities cannot reactivate, and a reused display name creates
a different identity. Default and explicit topic bindings preserve exact audiences.
One repository check and two HTTP/application checks pass in isolated Compose.
The initial TypeScript readonly assignment and an overly broad reserved-name check
were corrected before the final repository run. AST-only Graphify: 419 files,
2,562 nodes, 10,329 edges; zero model calls. Native administration, browser admission
against this catalog, saved preference migration, and browser media preparation
ordering still need their combined integration and acceptance.
[Profile repository evidence](compatibility/results/2026-09-18-store-runtime-profiles.json).

The browser media test exposed a first-submission cancellation: initial transcript
selection advances the guard revision after intake. Execution now binds the
current prepared representation immediately before its first native request, with
that request intent persisted in control. It can rebind an unstarted submission
after initial preparation; subsequent guard changes still revoke requested or
running work. Installation generation and workflow ownership cannot change through
this step. Default logical profile IDs are stable across guard revisions in both
TypeScript and Python, while native directories remain generation/epoch isolated.
The originally failing audio case now passes, alongside four affected PostgreSQL/
HTTP checks and thirteen offline native checks. TypeScript, diff hygiene, and
AST-only Graphify pass (419 files, 2,564 nodes, 10,337 edges; zero model calls).
Native administration/catalog admission integration remains pending.
[Browser media evidence](compatibility/results/2026-09-18-store-browser-media.json).

Native Hermes administration now resolves profile authority through control storage
for the original-only layout. Filesystem owner markers cannot grant a profile;
old generation paths, wrong audiences, and symlinked homes fail closed. Create,
rename, and retirement use the owner profile repository. Stable preference homes
survive rename/retirement, and the next native turn receives saved preferences
without copying old sessions or notes. Native launches carry installation, guard,
and logical-profile identities; browser capture/admission use the stable identity.
Admission and execution recheck active catalog membership, including retirement
while a prepared run is queued. Capture can still spool through database outages.
Four PostgreSQL/HTTP checks and 35 offline pinned-native checks pass. An initial
assertion expected not-found instead of the existing scope-denied response; the
assertion was corrected and the entire affected database batch repeated. TypeScript,
diff hygiene, and AST-only Graphify pass (421 files, 2,590 nodes, 10,427 edges;
zero model calls). Saved preference migration, confirmed browser delivery, complete
UI/runtime rehearsal, and scheduler integration remain pending.
[Native profile evidence](compatibility/results/2026-09-18-store-profile-administration.json).

Schedule definitions and occurrences now have an explicit control repository.
Immutable definition documents, exact prompts, guarded prompt representations,
and trigger documents live in derived storage. Control retains typed references,
configuration, monotonic native cursor revisions, and execution identities.
Neither definitions nor fires create archive records. Derivative/control outages
and lost commit acknowledgments replay the same operation; duplicate and delayed
updates cannot replace newer definitions. Changed execution versions revoke
contexts and cancel affected pending work, while clock-only completion checkpoints
preserve their already-admitted occurrence. Overlap and missed occurrences are
recorded without authorizing execution. Explicit guard-off admission works without
a detector. Native scheduling sends stable catalog profile identities.
Three PostgreSQL/HTTP checks and 14 offline pinned-native checks pass. Definition
return typing and a missing test import were corrected before successful final
compilation and the repeated affected database batch. AST-only Graphify: 423 files,
2,607 nodes, 10,530 edges; zero model calls. Scheduler claims, results, delivery
approval, native execution/recovery, and Inngest operation registration remain
pending; those HTTP operations fail closed until their migration is complete.
[Schedule storage evidence](compatibility/results/2026-09-18-store-schedule-storage.json).

Browser and scheduled execution now share the same claim/lease/result recovery
protocol with explicit channel-specific root and preparation repositories.
Scheduled turns use control operation roots and current guarded prompt derivatives;
no invented archive source is required. Claims carry logical profile, installation,
guard, and job bindings. Revocation, cancellation, expired leases, missing native
receipts, and durable derivative recovery use the same identity without rerunning
uncertain effects. Scheduled result history remains derived, and completion closes
the runtime capability. A separate trusted completion path stages an exact Telegram
proposal from a verified local result; it cannot reopen that capability or send
without the existing approval path. Inngest schedule/run operations and owner
workflow cancellation now use control metadata. Generated runs have no archive
source link. Native scheduling resolves stable profiles for both layouts.
Eight PostgreSQL/HTTP checks and 37 offline pinned-native checks pass, including
browser/action regression coverage. An initial native batch found test environment
restoration leaking a deleted temporary home; cleanup was corrected and the entire
37-check batch passed. TypeScript, diff hygiene, and AST-only Graphify pass
(426 files, 2,640 nodes, 10,702 edges; zero model calls). These are synthetic service
and native checks, not the complete Inngest/Compose/UI installation rehearsal or
fresh provider/live acceptance. Host imports, complete portable bundles and backup
coordination, browser delivery evidence, reset, and fresh gates remain pending.
[Scheduled execution evidence](compatibility/results/2026-09-18-store-scheduled-execution.json).

Host import admission and batch writes now use the separated repositories. Each
write holds the current import lease through original capture, file storage, or
explicit learning consent. Control retains typed job/source membership, progress,
owner controls, and response-loss receipts. Cancellation and lease expiry fence
later writes; history does not dispatch replies or learn without approval. Batch
review cannot cross job membership, and replay cannot undo an owner revocation.
Six PostgreSQL/HTTP checks and eleven offline native batching/workflow checks pass.
Initial fixture run IDs and injected-outage status expectations were corrected;
the final serial database batch passes all six checks with no skips. TypeScript,
diff hygiene, and AST-only Graphify pass (428 files, 2,648 nodes, 10,766 edges;
zero model calls). Complete/legacy portable bundle routing, native-store transfer,
full backup coordination/rehearsal, browser delivery evidence, reset, and fresh
live gates remain pending. No installation data was deleted or reconfigured.
[Host import evidence](compatibility/results/2026-09-18-store-imports.json).

Original-only exports now compose source records/files, derivative/guarded history,
Hermes notes/SQLite sessions, and configured Honcho memory rows/embeddings into a
checksummed `nocheh-portable-v2` package. Archive-only dashboard downloads use the
source-only API. Honcho snapshots use one repeatable-read PostgreSQL snapshot and
exclude queues/webhooks. Every source, parent, and active revision needed by
materialized derivative records must be present before the complete manifest is
atomically published. Configured native-store outages leave incomplete exports.

Portable import validates inventory/checksums/reference closure before remote
writes, routes sources and derivatives through their owner repositories, and
stages native history with an inactive marker and durable receipt. Interrupted
imports can replay the same package; changed destination notes are preserved by
rejecting overwrite. Three PostgreSQL/source/derivative checks pass, with the full
bundle check repeated after closure validation. A separate PostgreSQL snapshot
probe verifies eight native memory tables under a concurrent update. Twenty-five
offline pinned-native checks pass. The initial API fixture lacked the native
module mount and was corrected. A host-only regression invocation could not bind
its restore test port; the complete final suite passes in the isolated container.
TypeScript, Python compilation, documentation links, diff hygiene, and AST-only
Graphify pass (432 files, 2,684 nodes, 10,901 edges; zero model calls).

Native Honcho database rehydration, legacy bundle conversion, coordinated full
backup/restore, complete Compose/native/UI rehearsal, confirmed browser delivery,
reset, and fresh live gates remain pending. Native staging is not native database
restore or activation evidence; no live data or provider was used.
[Portable bundle evidence](compatibility/results/2026-09-18-store-portable-bundle.json).

Portable Honcho memory rows now restore into a schema-compatible initialized
native database in an inactive installation. The coordinator checks inactive
ownership and running/orphan writers before connecting. Restore stages typed
rows in temporary tables, checks all target memory and operational tables, and
materializes memory in one transaction. It accepts an exact completed replay,
advances native identity sequences, and rejects conflicting destination content,
queued native work, incompatible columns, or malformed rows. It does not start
services, attach memory, copy credentials, or change spending accounting.

The PostgreSQL rehearsal verifies eight-table export/restore, consistent concurrent
snapshot, malformed later-row rollback, queue and schema rejection, exact replay,
identity sequences, and preserved destination changes. Twenty-six offline pinned
Python checks pass. Python compilation, documentation links, diff hygiene, and
AST-only Graphify pass (432 files, 2,689 nodes, 10,923 edges; zero model calls).
This uses synthetic native table fixtures; complete acceptance against the pinned
Honcho service, coordinated full recovery, legacy bundle conversion, and the
remaining installation/reset/live gates are still pending.
[Native portable restore evidence](compatibility/results/2026-09-18-native-portable-restore.json).


Legacy mixed archive records and complete v1 portable bundles now route through
the separate repositories. Original identities and file bytes remain exact;
generated contexts, outputs, and generated file bytes become immutable imported
derivatives. Each entire incoming document is retained before conversion, including
guarded owner edits that conflict with destination history. Optional guarded
restoration preserves revision authors and content but leaves heads pending.
Replay cannot replace later destination edits or revive execution checkpoints.
Observed Telegram delivery messages alone become original evidence; old drafts
and receipts cannot cause delivery. Historical bigint file sizes are normalized
without changing the retained input document.

Seven PostgreSQL/HTTP checks and 27 offline pinned native checks pass, with no
skips or provider calls. TypeScript/Python compilation, documentation links,
diff hygiene, and AST-only Graphify pass (434 files, 2,703 nodes, 11,011 edges;
zero model calls). Combined Compose/native/UI and coordinated recovery rehearsal,
confirmed browser delivery, installation reset, and fresh live acceptance remain
pending. No installation content or configuration changed.
[Legacy import evidence](compatibility/results/2026-09-18-store-legacy-import.json).


Browser completion now creates an immutable delivery offer outside archive.
The native dashboard verifies the received text hash and retains only opaque
receipt IDs/hashes for retry. Its authenticated acknowledgment fsyncs the exact
assistant message and original reply relationship into the source spool, without
requiring databases or Inngest. Server emission, drafts, hidden results, and failed
runs do not count as client receipts. Duplicate receipts preserve one source;
reset removes offers so old browser outboxes cannot restore deleted content.
Receipt capture is independent of a later native profile generation, and source
replay applies normal preparation and learning boundaries. The complete native
candidate image builds. Its 232-check suite passes 230 checks offline; the two
host-only Compose and actual container-isolation checks pass separately. Initial
temporary-mount and missing fixture-parent failures were corrected and repeated;
these were fixture issues, not fresh live evidence.

Four PostgreSQL/HTTP checks, two filesystem/browser-client checks, and 28 offline
pinned native checks pass, including outage/restart/replay, exact text, reply
resolution, receipt integrity, missing offers, owner authentication, and inert
server-side completion. Native dashboard assets compile. AST-only Graphify has
438 files, 2,726 nodes, and 11,081 edges, with zero model calls. Combined browser
reconnect/media-generation acceptance, full coordinated recovery, reset, and fresh
live gates remain pending. A received browser transport frame proves client
receipt, not that a human read it; no live installation was changed.
[Browser delivery evidence](compatibility/results/2026-09-18-store-browser-delivery.json).


Native portable recovery now passes against the pinned Honcho Alembic migrations
and ORM models on real PostgreSQL/pgvector, including 1,536-dimensional embedding
columns, source citation ancestry, soft-deleted interpretation history, and exact
eight-table replay. Exported and restored row bytes and schema metadata match.
The dedicated internal-only fixture uses synthetic credentials and no published
ports, API/deriver/provider service, installation state, or provider requests.
This closes the native-schema portability check; combined Honcho service behavior,
coordinated backup/restore, installation reset, and fresh live evidence remain
separate pending gates.
[Pinned native portability evidence](compatibility/results/2026-09-18-pinned-native-portability.json).

Production CLI backup/restore orchestration now passes a coordinated format-6
rehearsal in two fresh synthetic Compose installations. It preserves all 74
archive/derived/control tables, 12 native Honcho tables with real pgvector data,
14 Inngest tables, Redis state, 23 state files, exact original bytes, two generated
versions, durable owner-guarded history, native sessions/notes, and spending
accounting. Restore verifies rows/sequences and leaves domain roles NOLOGIN,
provider logins inactive, Honcho detached, and only its PostgreSQL container up.
Both fixture projects and their volumes/networks were removed after verification.

This exposed and fixed workflow restore's use of the application administrator
credential: the original-only layout now runs its workflow-only provisioning
entrypoint through the setup service without activating the restored domains.
Eighteen recovery checks pass. The first rehearsal rejected an incorrectly shaped
synthetic detector response; correcting the fixture allowed the complete run to
pass. No production data or provider credential was used.

The CLI rehearsal exposed a separate dashboard coordinator shutdown issue,
addressed by the dashboard maintenance increment below. Full native/application/UI
rehearsal, saved preference migration, scoped reset, and fresh live gates remain
pending.
[Coordinated recovery evidence](compatibility/results/2026-09-18-coordinated-store-recovery.json).

The complete TypeScript/dashboard regression suite passes all 140 checks with
zero skips in the synthetic PostgreSQL/Inngest Compose fixture. It includes
container dashboard boundaries and real pinned Inngest inspection. The first
run had 139 passes and one fixture authentication failure: store bootstrap had
rotated the shared workflow password. The fixture now preserves its configured
password; compilation and the full serial rerun pass. This is component and
service regression evidence, not the full running native/UI or fresh live gates.
[Full regression evidence](compatibility/results/2026-09-18-full-store-regression.json).

Dashboard-started original-only backups now fence new management/native/provider
requests, drain already-admitted requests and OAuth callbacks, and keep the active
job's progress readable. The backup verifies the exact current dashboard container
and a per-operation readiness token before exempting it from writer shutdown.
Changed readiness or container identity fails closed; unrelated writable mounts
still block the backup. Resume starts only the previously running services, without
restarting setup dependencies while the maintenance lock is held.

The real management candidate image passes a dashboard-triggered coordinated
backup and separate inactive restore in fresh internal-only Compose installations.
The coordinator survives, Inngest resumes, and all 74 domain tables, 12 Honcho
tables, 14 Inngest tables, Redis state, 24 state files, exact originals, both
engine versions, durable owner edits, native sessions/notes, and spending accounting
survive. Restored domain roles cannot log in and provider logins remain inactive.
Nine distinct dashboard/HTTP/OAuth checks and twenty Python recovery checks pass.
An initial TypeScript field typing error was fixed; host socket restrictions were
resolved by running the affected checks in isolated containers. AST-only Graphify:
447 files, 2,770 nodes, 11,162 edges, zero model calls. This closes dashboard backup
coordination, not the combined running native/UI or fresh live acceptance gates.
[Dashboard recovery evidence](compatibility/results/2026-09-18-dashboard-store-recovery.json).













The guard repository now stores immutable inputs, fragments, automatic/owner
revision history, and activation evidence in derived storage. Control owns mode,
epoch, invalidations, and publication receipts. Publication first revokes prior
contexts, then changes the derived active pointer, then confirms completion;
pending publications fail closed. Durable activation evidence reconciles a lost
completion response even after a newer owner edit has superseded that revision.
Owner edits survive delayed automatic detection, explicit restores create new
revisions, and repeat initialization/new connections preserve history.

Guard/storage verification: Node 24 compilation and all three affected real-DB
tests pass (no skips), with AST refresh at 309 files, 1,895 nodes, and 6,824 edges.
A preceding storage rerun exceeded its 60-second test timeout while PostgreSQL
was waiting on WALWrite; it is recorded as cancelled, not passed. The repeated
run used a five-minute integration bound and retained durability settings.
Automatic approval review rejected an unguarded test-reset patch before it ran.
The guard test reuses its synthetic database; destructive fixture cleanup now
requires the dedicated `nocheh-stores-fixture` PostgreSQL cluster marker as well
as the explicit fixture opt-in. The task-owned fixture alone was restarted to
set that marker. Its optional Inngest/Redis services are stopped after acceptance.
[Guard evidence](compatibility/results/2026-09-18-guard-store-recovery.json).
Production callers still use their existing guarded path; this is not activation
or evidence that the full data-store migration is complete.

The reprocessing repository adds idempotent owner requests to the existing
preparation outbox, validates original file references and bytes, and persists
output before guarded preparation or completion. Its execution step holds the
existing preparation authority fence and a per-job lock. The subscription engine
uses the pinned native `perception.transcribe` contract; deterministic fixture
engines verify two versions without adding a provider integration.

Selections preserve immutable revision and activation history, require prepared
guards, allow automatic selection only for the first result, and use the same
revocation-before-publication protocol as guard edits. Old contexts fail closed
after activation and Honcho/native review refreshes are requested. Reprocessing
does not silently activate its output or copy an old owner's edit to new text.

Node 24 compilation and four affected real-PostgreSQL tests pass without skips,
including guard-failure retry without another transcription, two engine versions
over exact original bytes, explicit switching/backtracking with retained owner
edits, unprepared activation denial, and interrupted selection reconciliation.
AST-only Graphify: 314 files, 1,918 nodes, 6,932 edges, zero model calls.
[Reprocessing evidence](compatibility/results/2026-09-18-derivative-reprocessing.json).
These interfaces are still candidate repositories; production/API/CLI/dashboard
callers and the remaining migration have not been switched.

The new source projection normalizes reply targets and individual/anonymous
reaction observations, including source timing, actors when supplied, exact
reaction types, additions/removals, and anonymous counts. Unknown future fields
stay in original payloads. The frozen legacy projection is unchanged. Incoming
wire batches are classified as observed originals, and capture records reaction
timestamps even when no message body is available.

The archive relationship repository resolves old targets independently of graph
pagination. Scoped readers cannot use unknown or contradictory topic membership,
and external reply targets require their own matching audience. The owner can
inspect unresolved references. This is scope filtering, not a control-policy grant;
production retrieval must also apply consent and action authorization.

Node 24 compilation, nine affected TypeScript/PostgreSQL checks, and six Python
capture checks pass. No fresh human reactions, subscription checks, or live gates
are claimed. [Relationship evidence](compatibility/results/2026-09-18-source-relationships.json).
Learning and production store routing remain pending.

Owner project and sharing policy repositories now live in control storage. They
provide revision-checked, idempotent create/edit/archive, chat/topic assignments,
explicit exclusions, inherited topic membership, and selected sharing rules.
Every mutation checks owner authority, advances the guard/access epoch in the
same transaction, and requests memory refresh. Project membership does not
create a sharing rule or authorize reading another conversation. Sharing rules
only select inputs for a separately prepared release; raw access is not granted.

Node 24 compilation and all four affected real-PostgreSQL checks pass, including
owner-only changes, idempotence, inheritance/exclusion, stale revisions, archived
project handling, exact sharing destinations, and revocation of old contexts.
AST-only Graphify: 321 files, 1,969 nodes, 7,114 edges, zero model calls.
[Project policy evidence](compatibility/results/2026-09-18-project-sharing-policy.json).
Sharing content preparation/approval, production routing and owner interfaces
remain pending; this is not a claim that project UI or sharing delivery is done.

The bounded Honcho provenance reader follows conclusion ancestry to native
message IDs and maps those IDs through confirmed Nocheh ingestion receipts.
Every native query is workspace-scoped; Nocheh checks the current installation,
guard epoch, audience, and attached/verified state before and after the read.
Missing conclusions, truncated ancestry, absent message metadata, and unverified
ingestion links are explicit limitations. Ancestry is not labeled an exact quote
citation. The adapter reads no conclusion text or embeddings and calls no model.

Two affected real-PostgreSQL checks and three Python ancestry checks pass. The
new route registers successfully against the pinned Honcho image in a disposable
container with networking disabled and no credential/state mounts. AST-only
Graphify reports 326 files, 1,986 nodes and 7,168 edges. Native database traversal,
full inference integration and fresh live acceptance remain pending.
[Provenance evidence](compatibility/results/2026-09-18-honcho-provenance.json).

Learned-memory projections now retain immutable derivative versions, provenance,
guarded outputs, evidence dependencies, owner corrections, and retirement history.
Publication uses the same recoverable control-revocation/derived-activation protocol.
Owner corrections cannot be replaced by automatic proposals; changed guarded input
or selected derivative revisions block reuse of dependent inferred projections.
Model-facing reads require scope and evidence authorization in addition to guards.
Owner inspection/history are separate administrative operations.

Interpretations support meanings, subject states, and quoted participant conventions.
Project-wide conventions require a quoted unambiguous project reference. Explicit
rules outrank inferred meanings, owner corrections outrank affected interpretations,
and conflicting explicit rules remain visible without arrival-order resolution.
The result schema cannot set administrative, guard, provider or privacy policy.

First guarded preparations/new projections now preserve the current epoch because
no earlier authorized representation exists. Pending publication still blocks reads;
changing existing content or selecting an engine revokes the epoch before publication.
This prevents initial preparation from causing endless unrelated memory rebuilds.

Node 24 compilation and all four learned/guard/reprocessing checks pass. A preceding
run found an ambiguous history join; that run failed and the fixed query passed the
rerun. AST-only Graphify: 330 files, 2,012 nodes and 7,297 edges, zero model calls.
[Learned version evidence](compatibility/results/2026-09-18-learned-memory-versions.json).
Automatic Honcho learning execution, native memory refresh integration, production
routing, owner interfaces and live acceptance remain pending.

The candidate automatic-learning worker prepares permitted source and relationship
evidence independently of reply dispatch. It uses the guarded Honcho reasoning
endpoint, preserves completed results before preparation/publication, and records
inspectable meaning/state/convention versions without any delivery or acknowledgment
operation. Imports require explicit learning consent; live sources follow selected
conversation access. Unknown reaction topic context waits for its target.

Context includes bounded old-target observations and related activity. Embedded
reply/external-reply text is removed from the model projection until the target is
independently authorized. Only selected derivatives and applicable permitted rules
enter the request. Exact source/guard/selection dependencies and existing corrections
are checked on use. Identical authorized inputs reuse completed work across unrelated
generation changes, preventing recursive learning from its own output.

Prepared projection batches record all pending activations and workflow recovery in
one control transaction before exposing changed versions. A crash after one derived
activation leaves the batch unavailable; resumption reconciles the remainder using
the saved reasoning result. Existing owner corrections are not overwritten.

Node 24 compilation and five affected synthetic/PostgreSQL checks pass; a targeted
rerun additionally proves update-batch revocation and partial-publication recovery.
No external provider or Telegram calls ran: Honcho reasoning is a deterministic
fixture. AST-only Graphify: 334 files, 2,035 nodes, 7,488 edges, zero model calls.
[Automatic learning evidence](compatibility/results/2026-09-18-contextual-learning-worker.json).
The production workflow handler, native ingestion/context integration, owner UI,
portability, full rehearsal and fresh live gates remain pending.

</original_only_archive>

<conversation_state_inference>

## Conversation state and conventions — 2026-09-17

The owner's requirement is recorded under "Conversation state and conventions"
in [SPECS.md](SPECS.md). Implementation and live acceptance are pending.

Source inspection confirms that `src/source-model.ts` projects authorship,
containment, replies, and threads. `integrations/hermes/capture.py` preserves
delivered reaction and reaction-count updates, but the legacy source projection
does not normalize their message/actor relationships. `src/graph.ts` renders
recorded relationships; that does not establish interpretation of task state.
The generic source contract can represent additional relations and operations,
but this is not evidence of an implemented reaction-driven state-inference flow.

Implementation planning needs normalized reaction/change capture, retrieval of
the affected older source context, and a durable path to refresh derived state.
Define how group/project rules are supplied, attributed, scoped, updated, and
combined with learned conventions. Rule precedence and maintenance controls need
a concrete design; no new database layout or prompt-management mechanism is
selected by this documentation increment. Coordinate derived-state placement
with the pending [archive separation](docs/adr/0052-pure-source-archive.md).

Pending acceptance covers a check reaction on an old task under an explicit
completion convention; a different meaning in another group/project; learned
and ambiguous meanings; reaction removal/replacement and later corrections;
duplicate, delayed, and out-of-order observations; missing actor/context; and
audience/consent enforcement without treating reactions as action approvals.
Verify source preservation and the state-to-evidence trail across restart.

This increment changes specifications and status only. Documentation structure,
links, consistency, and requirement coverage are checked. No runtime changes,
reaction subscription checks, inference tests, or live acceptance are claimed.

</conversation_state_inference>

<archive_storage_boundary>

## Pure source archive boundary — 2026-09-17

The owner clarified the archive's storage boundary after inspecting the database
schema. The durable requirement is in [SPECS.md](SPECS.md), with the boundary
decision and supersession in [ADR-0052](docs/adr/0052-pure-source-archive.md).

Source inspection confirms that `src/database.ts` initializes archive, guarded,
memory, execution, security, and workflow tables through one PostgreSQL client.
Native Hermes notes remain profile files and its sessions remain native SQLite;
Honcho has a separate PostgreSQL store. However, the Nocheh database stores memory
review content, filtered memory, Honcho receipts/context caches, and operational
state. `integrations/hermes/prepared_context.py` also submits native memory text
and tool results for preparation; `src/prepared-context.ts` persists new fragments
as `derived_artifacts.kind = 'runtime_context'`, alongside guarded revisions.
The archive therefore does not yet satisfy the clarified boundary.

Implementation and migration are pending. Define the table/content split and
durable handoff before moving data; preserve original bytes, source IDs,
provenance, owner revisions, consent, audience enforcement, and effect receipts.
Backup/restore and failure-path acceptance must cover the separated stores.
Clarification pending: whether transcripts and extracted file text belong in
the source archive or a separate derived-data store. Their existing preservation
and guarding requirements remain in force. The target database/role layout and
cross-store consistency mechanism have not been selected.

This increment changes documentation only. Structure, local links, diff hygiene,
and related-spec consistency are checked; no data migration, runtime activation,
or live database inspection is claimed.

</archive_storage_boundary>

<dashboard_refactor>

## Dashboard UI/UX refactor — 2026-09-17

The accepted whole-dashboard design and metrics requirements are in SPECS.md and
[ADR-0050](docs/adr/0050-dashboard-components-and-workflow-metrics.md).
The component foundation adds pinned Radix/shadcn-style primitives, Tailwind,
Lucide, browser TypeScript, persisted adaptive themes, grouped responsive
navigation, bounded lazy asset serving, and shared cancellable data subscriptions.
Refresh retains the mounted page and unsaved edits.

Foundation verification: Node 24 production build, two dashboard authentication
and asset/native-boundary tests, and nine graph tests pass. AST-only Graphify
refresh: 276 files, 1,701 nodes, 6,002 edges, zero model calls. Shared-browser
checks on the synthetic Compose fixture confirm dark/system and light themes,
375px navigation drawer, Escape and focus restoration, no main-content horizontal
overflow, and a settings edit surviving manual refresh. The following increments record full route acceptance
and historical metrics verification.

The fixture uses project `nocheh-dashboard-ui-20260916`, its own database/volume,
a private database network, a separate localhost HTTP bridge, and port 18848.
The persistent preview terminal is `49234`. No provider credentials, poller,
scheduler, or external-effect executor is attached. Initial database startup
exceeded the health window; the healthy database was retained and preview
startup retried. Registry-backed `npm ci` in Docker stalled and was cancelled;
compiled assets run on the locally cached pinned runtime image. A clean container
build remains pending. [Evidence](compatibility/results/2026-09-17-dashboard-foundation.json).
Foundation commit `699edf9` is integrated into local main. GitHub fetch/push
failed with `could not read Username; terminal prompts disabled`.

The metrics increment adds bounded PostgreSQL registry aggregates and query
indexes, authenticated owner/legacy proxy routes, lazy Recharts activity/outcome/
duration/current-workload charts, chart data tables, and paginated workflow
history with an accessible receipt drawer. Two database tests and two owner
management tests pass, including aggregate boundaries, both ranges, filters,
deduplication, retry-inclusive duration, invalid samples, domain-vs-registry
completion, terminal failures, empty data, metadata privacy, authentication,
aliases, and import consent/resume regressions. The Node 24 production build passes.
Browser checks confirm independent chart filters, table pagination, drawer focus
restoration, in-place retry receipts, and retained stale status/charts after an
injected outage. The graph refresh reports 1,701 nodes and 6,017 edges with zero
model calls. Monitoring commit `0e1e81c` was reconciled with concurrent source-model main
`b1a4a3d`: production build, eight affected PostgreSQL tests and eleven dashboard
tests pass. Final remaining-page acceptance is recorded below.
[Metrics evidence](compatibility/results/2026-09-17-dashboard-metrics.json).
The final page refactor replaces the legacy monolith with page components,
shared controls, subscriptions and revision-bound drafts. Overview, archive,
memory, Honcho, integrations, imports, activity, memory access, settings,
maintenance and graph now use the shared presentation. A route-handoff race in
shared subscriptions has a focused regression test. Refresh retains selection,
unsaved edits and the original compare-and-swap revision; stale saves reject.
Import consent and group mappings remain bound to the selected job and resume.

Final checks: 92 tests pass in the clean image; its one container-boundary test
runs separately with synthetic loopback service aliases and passes. That covers
all 93 tests, including the three new subscription regressions, existing graph,
owner-session, privacy, workflow, native Inngest inspection, database startup,
source preservation and import consent/resume checks. Host Node 24 and the clean
locked-dependency Docker development build pass; npm reports zero vulnerabilities.
The initial network build blocker is resolved. The production runtime image also builds successfully; its digest
is recorded in the final acceptance file.

Browser acceptance covers all twelve routes in light/dark at 375, 768, 1024 and
1440 pixels, with no page-level horizontal overflow. Additional checks cover
chart filters/data/keyboard tooltips, zero/unavailable/stale observations,
pagination, receipt drawers, exact approvals and bounded permission revocation,
guarded editing and stale-save rejection, settings conflicts, import consent and
resume, audience previews, memory history, and backup/restart/restore reviews.
Escape restores focus. Graph sources remain inspectable under injected graphics
failure. Loaded reduced-motion CSS disables transitions/animation; chart
animations are disabled. Checked text/status token pairs exceed 4.5:1 in both
themes. Recharts and Three.js are absent from the main entry bundle and load
through separate dynamic imports. The final AST graph includes TSX/JSX:
300 files, 1,832 nodes, 6,634 edges, zero model calls.

The final fixture adds optional pinned Inngest/Redis acceptance dependencies on
its private network with no registered runtime workers or published ports.
Cached-image Python allowlist and invalidated host-build-mount failures were
resolved by testing the clean immutable image. Host suspension stopped the
fixture; ownership was checked before restarting it. The final preview uses terminal `5513` and image
`nocheh-dashboard-ui-final:20260917`; the optional native check services are stopped.
[Final acceptance](compatibility/results/2026-09-17-dashboard-acceptance.json)
records build, browser, test, isolation, and setup-retry details.

After the owner's explicit request to build Docker and show the changes at
`http://localhost:8783/#monitoring`, the local installation's `nocheh-app` and
`nocheh-dashboard` images were built from `e0d8666` and recreated with Compose
`--no-deps --no-build --wait`. Both are healthy. Every other installation
container retains its identity; the existing runtime, executor, provider, and
storage services were not recreated. The browser shows the new monitoring UI,
status badges, four charts, period/family controls, and chart-data disclosure.
Owner-session requests for both historical ranges and the legacy alias return
bounded aggregates; unauthenticated metrics return 401. This is a local dashboard
activation, not a broader release or provider cutover. The persistent dashboard
log terminal is `58831`.
[Local activation evidence](compatibility/results/2026-09-17-dashboard-local-activation.json).

The owner reported that the summary data values were still uncolored. Workflow
summary values now use their semantic status colors directly, with matching
Lucide label icons. Missing values remain neutral, while observed zero counts
retain their labeled category. Both light/dark themes pass browser checks at
375 and 1440 pixels with no horizontal overflow; unavailable values are neutral
in both themes. Value contrast on panel surfaces is at least 5.5:1. The pinned
Docker production build and all 12 dashboard checks pass. The AST-only graph
refresh reports 300 files, 1,946 nodes, 6,800 edges, and zero model calls.

The verified management image is installed in the local dashboard at port 8783;
only that container was recreated. All five live metric values and label icons
are visibly colored, and the open Monitoring tabs were refreshed. The initial
live workflow observation was unavailable and recovered on subsequent polling.
The synthetic preview remains on port 18848 in persistent terminal `86398`.
[Value-color evidence](compatibility/results/2026-09-17-dashboard-value-colors.json).

</dashboard_refactor>

<compact_monitoring>

## Compact Monitoring dashboard — 2026-09-16

Owner accepted a compact operational summary in Nocheh with expandable details
and an obvious **Open Inngest** link. Monitoring shows all-family running,
waiting and failed totals, last confirmed workflow completion, and unpublished
backlog. Detail sections retain workflow filters, receipts and authorized controls,
Telegram history, provider observations, background work and service diagnostics.
Uncertain outcomes, stale workers and unhealthy services remain visible.

Verification: pinned Node 24 fixture image and TypeScript/dashboard build pass;
five focused workflow/owner-session/native-inspection tests and nine existing
dashboard tests pass. Shared-browser checks cover collapsed defaults, filtering,
keyboard disclosure, inspector focus, retry/cancel, ten-second refresh,
unavailable/stale observations, authenticated Inngest navigation and 375px layout.
The AST graph was refreshed without model calls. [Evidence](compatibility/results/2026-09-16-compact-monitoring.json)
retains fixture setup failures and their successful retries. The isolated preview
runs on port 18837; deployment to the active installation was not performed.
Feature commit `25982bc` is verified. GitHub HTTPS authentication blocks fetch
(`could not read Username; terminal prompts disabled`); remote synchronization
remains pending.

</compact_monitoring>

<import_extensibility_review>

## Platform-independent import database — 2026-09-16–17

The owner authorized implementation after requesting a long-term database design
for future platforms, including Slack and Discord. [ADR-0051](docs/adr/0051-platform-independent-sources.md)
records the accepted design; the [source-model guide](docs/source-model.md)
defines the adapter contract and isolated acceptance procedure.

Implemented an additive PostgreSQL model for source objects, revisions, immutable
observations, typed relationships, and migration receipts. Identities distinguish
platform, namespace, object kind, and opaque external ID. They are independent of
connector installation and local audience. New platforms use versioned source
descriptors with adapter provenance, completeness, operation, and metadata.
Unknown original fields and exact source/file bytes retain their preservation paths.

Serialized migration backfills existing events in batches without changing event
IDs, hashes, original bytes, owner edits, dispatch receipts, or learning consent.
Telegram Bot API and Desktop identities retain separate namespaces. Graph queries
use the common relationships, resolving only authorized observations. Portable
exports retain explicit descriptors; guarded reads omit unprepared metadata.
New channels cannot trigger Telegram dispatch or attachment downloads. Snapshot
fingerprints include all five new source-model tables.

Validation: the pinned TypeScript compiler/dashboard build passes locally. The
Node 24/PostgreSQL regression run initially recorded 82 passes, four failures,
and three fixture-dependent skips. A scheduler compatibility regression was fixed;
approval and dashboard failures passed on retry; the database-disconnection test
requires its explicit isolated-fixture flag. All 14 affected regression checks
passed on their targeted rerun. All six final source-model/disconnection tests
passed, including a backfill spanning more than 200 records. Across the suite
and targeted follow-ups, 86 distinct checks passed; the three external-fixture
checks remain skipped. The 14 Python archive/import-job/operations tests passed.
The extra Docker compiler check was stopped after prolonged execution; it is
not a pass. Fixture-only dump/restore and restart preserve identical fingerprints
for 11 checked tables, including all five source-model tables.
[Content-free acceptance evidence](compatibility/results/2026-09-17-source-model.json)
records coverage, fixture failures, successful retries, and build limitations.
The synthetic fixture container, network, and database volume were removed.
Integration with the concurrent dashboard foundation passes a full Node 24.13.0
build and 11 dashboard/auth/graph checks; 17 executor/operations Python checks
also pass. Backend dependency pins are unchanged. The AST graph was refreshed
without model calls. The new source decision is ADR-0051 to preserve the
concurrently accepted dashboard ADR-0050.

No Slack/Discord export parser, live connector, active-installation migration,
provider call, or deployment is included. Dedicated adapters can build on this
contract and the existing resumable import workflow. Real Inngest/bootstrap,
Docker-routing, and native UI acceptance remain separate fixture requirements.

</import_extensibility_review>

<application_database_bootstrap>

## Inngest database setup inside the app — 2026-09-16

Owner requested removing `inngest-db-init` and merging it into another service.
[ADR-0049](docs/adr/0049-application-database-bootstrap.md) puts provisioning in
`nocheh-app` before API readiness; Inngest waits for application and Redis health.
The dedicated database and restricted role are preserved. Restore overrides the
application command to run provisioning alone, without execution authorities.

Fresh isolated Compose startup, four Node 24 tests, six Python tests, concurrent
initialization, data preservation, startup during an Inngest outage, and invalid
credential rejection pass. Snapshot/inactive restore preserves 15 workflow tables,
Redis state and synthetic archive data; restart preserves the restored contents.
Only PostgreSQL and Redis run in the restored fixture. Test resources were removed.
[Acceptance evidence](compatibility/results/2026-09-16-application-database-bootstrap.json).
Documentation checks and the AST-only graph refresh pass. The installed image uses
the cached pinned Nocheh runtime and locked build dependencies; a registry-backed
build stalled and was cancelled. Code commit `9bb3d14` is integrated into local
main and installed. At that installation step, the app was healthy with
capture/outbox ready and workflows connected; all 15 running containers were healthy. Both database identities are
preserved, and the completed initialization container is removed without deleting
volumes. GitHub HTTPS authentication blocks fetch/push (`could not read Username;
terminal prompts disabled`), so remote synchronization is pending. This increment
is independent of the pending management migration.

</application_database_bootstrap>

<container_management_migration>

## Dashboard and executor in Docker — 2026-09-16

The owner requested renaming the executor service to `nocheh-executor`. Compose,
lifecycle commands, the monitoring catalog and the system diagram use that name.
Inngest application identities and durable receipts retain their existing identities.
All 28 focused checks pass on the host and in the rebuilt management image.
Synthetic Compose validation and the AST-only graph refresh pass. Code `e9004a9`
is integrated into local main and installed. The old executor drained normally and
was removed; `nocheh-executor` is healthy, all 17 services are healthy, all nine
workflow registrations refreshed, and Monitoring displays the new name. Host and
container lifecycle detection pass. Other container IDs and all volumes are preserved.
[Rename evidence](compatibility/results/2026-09-16-executor-rename.json).
The old dashboard's graceful shutdown stalled without active maintenance; its
process was terminated and the replacement started healthy. Bounded dashboard
shutdown and intermittent unavailable workflow/archive summaries need follow-up;
the service catalog, API/capture readiness and Inngest connectivity were available.
The concurrent compact-monitoring change is retained in Git but is not deployed by
this management-image-only rename. GitHub authentication still blocks remote push.

Owner requested moving the dashboard and executor into Docker, rebuilding services,
and cleaning up obsolete Nocheh resources. The prepared candidate was copied from
`codex/system-diagram-20260916` into `codex/system-map-20260916`, preserving the
original worktree. The owner then requested “fix all” and explicitly approved
Docker-socket access for both trusted management containers.

[ADR-0048](docs/adr/0048-containerized-management.md) records the administration
boundary. The candidate now includes the authorized socket and group, internal
service addresses, installation paths, container lifecycle and executor recovery.
Fresh isolated Compose acceptance passes startup, owner-authorized socket access,
real isolated tool execution, executor restart/reconnection, Inngest outage recovery,
container backup and inactive restore, diagnostics/restart, and dashboard availability
with the app stopped. The backup verifies 45 archive tables, 14 workflow tables and
15 synthetic state files. Owner and native Hermes pages render through the container.
No production credentials were copied into the fixture.

The serialized TypeScript/PostgreSQL suite passes 83 tests; its separately enabled
container-routing test also passes. The 175-test native suite had timing failures
under concurrent fixture load; both affected tests pass in isolated reruns. Its three
container-skipped checks pass separately on the host, including a real agent sandbox
that cannot reach credentials, sibling files, the Docker socket or the internet.
The 25 focused management Python checks pass. Initial timeout and diagnostic failures
are retained in the [fresh evidence](compatibility/results/2026-09-16-container-management.json).
Documentation checks and AST-only graph refresh pass.

Management, application and development images build from pinned inputs. The changed
Hermes integration is rebuilt over the verified pinned runtime layer; full upstream
Rust/Go downloads were cancelled after stalling. Unchanged provider, tool and store
images retain their existing pins. Commit `283ab38` is integrated into local `main`.
Fetch/push remain blocked by GitHub HTTPS authentication (`could not read Username;
terminal prompts disabled`). The installed 15 containers are healthy.

The owner explicitly approved the live local cutover. At that cutover, the host
executor and dashboard stopped and all **17 Docker services were healthy**, including
`nocheh-dashboard` and the then-named `nocheh-host-executor`. All nine workflow families have fresh worker observations.
The format-5 backup preserves 45 archive tables, 14 Inngest tables, 12 Honcho tables
and 919 files. Database identities and archive record counts are preserved; no data
volume was deleted. The 18 containers in other projects retain their original IDs.
The obsolete standalone `nocheh-dashboard:local` image and synthetic test resources
are removed; rollback images and the full snapshot are retained.

Live synthetic refresh ownership, chat, literal detection and required subscription
transcription all pass. The owner dashboard and monitoring run at
<http://localhost:8783/>. [Live evidence](compatibility/results/2026-09-16-container-management-live.json).

The live check exposed a Mac/Linux boundary: the host CLI cannot observe a lock held
inside Docker's VM. Executor lifecycle detection now queries Compose; Docker errors
fail closed rather than declaring the worker stopped. The supervisor retains its
in-VM exclusion lock. All 28 focused tests pass on the host and in the management
image; real host CLI observation, drain and restart also pass. The fix is integrated
and installed as `26febe1`. The first post-start check encountered temporary PostgreSQL
recovery; final identity, record-count, worker and service-health checks pass after
recovery. AST-only graph and documentation checks pass. GitHub HTTPS authentication
still blocks remote push; the verified implementation and evidence are on local main.

</container_management_migration>

<consolidation_implementation>

## Reviewed deployment and Inngest completion — 2026-09-16

Owner approved [ADR-0046](docs/adr/0046-consolidated-inngest-installation.md).
Implementation and local migration acceptance are complete on
`codex/system-diagram-01a0a683`. Code and deployment evidence through `3c282b6`
are integrated into local main; GitHub HTTPS authentication still blocks
fetch/push. The implementation adds supervised application/capture and Connect
composition,
stored-preparation consumption, the merged broker/guard, and native dashboard
presentation through managed Hermes administration.

That deployment used the [tool and purpose names](docs/services.md), two
host processes and 15 continuously running containers with Honcho enabled.
Isolated startup verified all 15 containers healthy and `inngest-db-init` completed.
The complete pinned Hermes/dashboard and Node 24 application images build.
Owner and native Hermes UI inspection passed; owner diagnostics completed with
all application containers stopped. The host executor recovers receipts even when
its Connect child is unavailable. Production credentials were not copied into
these fixtures, and their provider calls were disabled.

Fresh checks: 78/78 TypeScript/PostgreSQL tests; 169 passing native Hermes tests
with two optional checks skipped in that container; 17 focused host tests,
including the resolved Compose check; and the real agent-container isolation
fixture passed separately. Full-stack Inngest outage, application restart during
that outage, duplicate capture, durable outbox and reconnection passed. All nine
family ownership switches passed in the synthetic installation. Real Connect
pipeline validation passed preparation, Telegram, browser and scheduled receipts.
The host import probe preserved three batch receipts after a lost acknowledgement;
103 imported messages produced no replies or unapproved learning. The real-server
privacy probe rejected protected outputs/errors and scanned 1,126 stored rows
without finding the synthetic protected marker.

The format-5 backup now includes Honcho PostgreSQL, protected configuration,
spending ledger and separate native presentation preferences. A complete synthetic
backup/inactive restore passed archive, Inngest and Honcho fingerprints; restored
capture and workflows report inactive. The restore starts no execution authority
or Honcho writers. Existing format-3/4 backups remain readable.

Preparation admission now queues/observes stored requests in the owner API and
shared-memory reads; those callers no longer invoke a legacy detector. Turning
guarding back on admits new preparation generations while preserving closed
identities. Browser/scheduler claims require the current Inngest epoch. Eight
focused PostgreSQL tests pass, including mode changes, stale authority, duplicate
requests and withholding shared text until its saved projection is ready.

The fault rehearsal exposed a dependency delay: a turn could sleep through the
five-minute transcription recovery lease even after preparation completed.
Dependent workflows now recheck readiness through Inngest every two seconds;
preparation retains its provider backoff. Four focused tests pass. The repeated
rehearsal passed capture during PostgreSQL/Redis/Inngest outages, store restart,
crash after effect before acknowledgement, worker kill and duplicate-event
receipt reconciliation, with exactly three effects for three source identities.

The local installation now uses the canonical services and all nine families are
Inngest-owned at epoch 2. Format-5 snapshots
`data/backups/20260916-consolidation-complete` (722 files) and
`data/backups/20260916-pretelegram-complete` (726 files) passed validation before
the preparation-first, Telegram-second switches. Both handoffs had no live step
lease or unresolved receipt. Existing archive, provider login, Honcho stores,
spending ledger and closed effects were preserved; no application reset was used.
The earlier format-4 snapshot is also retained.

Live owner text and voice each completed once; the unmentioned group note was
intentionally suppressed. The original 18,346-byte voice file matches its SHA-256
and the transcript links to that same input hash. The selected group's reply did
not reveal the private synthetic marker; its scoped credential read the group
source (200) and was denied the private source (404). Post-cutover subscription
refresh, chat, detection and Ogg/Opus transcription passed.

Exact owner approval passed with a genuine `/approve` command and a confirmed
Telegram response containing the exact proposed sentence in the original private
chat. There was one send intent and one delivered result. Restarting Hermes
preserved both receipt hashes and that single send. Six earlier live turns also
retained their original receipt hashes and reply counts, including voice and
intentional silence. The earlier identifier-like proposal was masked by guarding;
the owner rejected it and approved the plain-language replacement. Guarding was
not weakened for acceptance.

The retirement increment is installed locally: legacy scanners, standalone
workers, engine-disable flags and rollback execution are removed. Fresh owners
default to Inngest; retained import receipts only reconcile while paused. Fresh
installations select isolated execution, shared providers and evidence memory.
Historical records and inactive restore holds are preserved. A final-image live
subscription check passed refresh, chat, detection and transcription. The last
pre-install format-5 snapshot contains 800 protected files and 45 archive tables.
The new fresh-install/inactive-restore rehearsal verified 45 archive tables,
14 Inngest tables, 23 synthetic files, Honcho state and all execution holds.

A final outage rehearsal exposed HTTP acknowledgement before Inngest's default
in-memory event consumer subscribed. [ADR-0047](docs/adr/0047-receipted-event-handoff.md)
keeps retrying the same event identity every 30 seconds until a fenced workflow
records receipt. All three focused outbox tests pass. Restarting the fixture
publisher recovered the observed lost preparation event; the full store outage,
crash-after-effect, worker-kill and duplicate-capture rehearsal then passed with
three effects for three sources. The fix is installed from local main `57fbab6`.
API, capture and Inngest
connectivity are healthy; all 15 containers are healthy. The pending exact-text
action stayed unapproved across an application/engine restart, all nine family
registrations reconnected, and the proposal-turn receipt stayed unchanged.
Completed-delivery restart acceptance also passed after the genuine owner command.
Across the retirement and handoff increments, 80 distinct service checks passed;
168 native checks passed, including a terminal-timeout rerun under lower load.
Three environment-dependent native checks passed separately in the 11-check
host run; another 28 host recovery/configuration checks passed.

Final cleanup removed the 21 obsolete installation containers, plus 39 stopped
containers and 12 empty networks belonging only to this session's completed
fixtures. No volumes or backups were deleted. The unrelated project was untouched.
The final installation has 15 healthy containers, two healthy host services,
`inngest-db-init` completed successfully, and optional pgweb stopped. Telegram is
connected; managed administration and the shared provider are available, with
CLIProxyAPI the sole login-refresh authority. The approved local migration has no
remaining runtime acceptance gate. Remote Git synchronization is still blocked.

[Consolidation evidence](compatibility/results/2026-09-16-consolidated-services.json).

</consolidation_implementation>

<production_completion>

Historical snapshot before the consolidation above; its topology and pending
gates describe that earlier maintenance checkpoint.

The owner-approved graceful OrbStack restart succeeded without a force-stop or
reset. All 38 previously running containers were restored, including the separate
coopr project. PostgreSQL recorded no further backend exits between its restart
at 19:58 UTC and the final maintenance check. The earlier backend-exit root cause
remains unproven. The checked-out database connection and guard cleanup repairs
are installed; all 76 isolated service tests passed without skips.
[Recovery evidence](compatibility/results/2026-09-16-database-recovery.json).

Production Honcho now runs in the main `nocheh` Compose project under
[ADR-0045](docs/adr/0045-honcho-in-installation-compose.md). The existing PostgreSQL
and Redis volumes were adopted, with a private database dump, Redis snapshot,
spending-ledger snapshot, and protected-configuration hashes retained. All 12
Honcho tables matched before and after adoption. A storage rollback rehearsal
started the old containers, verified those same fingerprints, then returned to
the new containers before starting writers. Nocheh attachment, generations and
receipts, provider credentials and spending policy were preserved. The five old
containers and two empty private networks were removed; no volume was deleted.
Twenty focused host checks passed. The pinned Hermes suite passed 161 tests with
three optional checks skipped; resolved Compose checks ran separately on the host.
[Consolidation evidence](compatibility/results/2026-09-16-honcho-compose.json).

Only `nocheh` and the unrelated `coopr` Compose groups remain. Nocheh has 20 running
services with healthy checks and one completed bootstrap container. Both host
workers run; all nine family admissions are open and all registrations are fresh.
Seven families retain Inngest ownership at epoch 2. Preparation and Telegram retain
legacy ownership at epoch 1. No ownership or closed execution identity was changed.
There is no admitted outbox backlog; legacy-owned pending requests remain visible.

Automatic primary Honcho context under ADR-0044 recovered through its existing
permanent workflow and dispatch. The maintenance-expired cache initially reported
limited memory, then the regular refresh restored current authorized context. A
scoped read returned the expected synthetic garden fact in 97 ms with memory
available. This is a context-read measurement, not end-to-end Telegram latency.
Hermes still uses small native notes, with Honcho as primary long-term memory.

The previous owner text and voice survived capture; the stored voice transcript
contains the expected synthetic phrase. Their one-attempt receipts remain closed:
text is ambiguous (`dispatch_interrupted`), voice suppressed (`unsupported_message`).
A captionless synthetic voice fixture passes, but that does not replace real
Telegram delivery acceptance. A fresh owner text/voice pair has been requested.
Group silence, isolation, approval and restart acceptance, the final two workflow
cutovers, and a new backup/inactive restore with populated context remain pending.
The earlier format-4 backup/inactive restore passed before this maintenance; its
cache table was empty and it is not fresh evidence for the current populated cache.

Stopped restore, fixture and obsolete dashboard containers were removed without
removing their recovery data or volumes. Two completed worktrees were removed;
untracked diagram context and graph artifacts were preserved under
`data/local/reports/worktree-cleanup-20260915`. The session branch is integrated
and has no active container mounts. Final worktree cleanup results are recorded
in the host reports after Git integration. Local commits are merged into main;
remote fetch/push remain blocked by GitHub HTTPS authentication.

</production_completion>

## Current recorded state — 2026-09-16

| Area | Actual implementation and activation | Evidence / execution plan |
| --- | --- | --- |
| Main integration | Refactor and Inngest consolidation integrated locally; historical legacy branch preserved. Local migration acceptance passes; remote push remains blocked. | [Integration evidence](compatibility/results/2026-09-11-main-consolidation.json), [rebuild plan](docs/rebuild-plan.md) |
| Runtime and owner dashboard | P1–P6 and dashboard D1–D4 implemented; P7 recovery tooling and the consolidated real Telegram acceptance gates pass. | [Runtime plan](docs/runtime-platform-plan.md), [operations evidence](compatibility/results/2026-09-08-runtime-platform-operations.json) |
| Guarded projections | G1–G3 and G5–G6 implemented; on/off guarding and owner edits active locally. G7 guarded recall/restart acceptance passed; Honcho/history acceptance remains separate. | [Guarded-memory plan](docs/guarded-memory-plan.md), [guarded acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json) |
| Security service | SEC1–SEC5 verified; isolated execution and evidence memory active locally. | [Security plan](docs/security-service-plan.md), [activation](compatibility/results/security-service-activation.json) |
| Telegram monitoring | Recovery supervision, observed polling health, workflow monitoring, and local OAuth callback implemented. | [Recovery evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json) |
| Shared provider | S1–S5 pass locally. Hermes uses the shared CPA route; exactly one CPA login is configured and the native login is retired. Text, privacy detection, voice, monitoring outage and full restart acceptance pass. | [Cutover evidence](compatibility/results/2026-09-14-shared-provider-cutover.json), [provider plan](docs/shared-provider-plan.md) |
| Honcho | Attached and verified locally without history backfill. Scoped recall, the native Hermes tool, group isolation, outage fallback and persistence pass with one ingestion receipt and one attempt. Embeddings retain the $5 pilot cap. | [Production acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [recall regression](compatibility/results/2026-09-15-honcho-recall-regression.json), [prior live acceptance](compatibility/results/2026-09-14-honcho-live-acceptance.json) |
| Space memory | M1–M5 implemented/fixture-tested within the recorded scope; filtered archive text supported. Filtering extensions and live checks below remain pending. | [Space-memory plan](docs/space-memory-plan.md), [fixture evidence](compatibility/results/2026-09-08-space-memory.json) |
| Specification workflow | AGENTS.md, SPECS.md, and plan/status consolidation implemented. XML structure, document links, requirement coverage, and supersession checks pass; runtime files and accepted ADRs are unchanged. | [ADR-0040](docs/adr/0040-specifications-and-agent-workflow.md) |
| Inngest workflows | All nine families are active on Inngest at epoch 2; legacy execution is retired. Text, voice, group silence, scoped isolation, fresh install/restore and fault recovery pass. Exact owner approval and final live restart pass. | [Consolidation evidence](compatibility/results/2026-09-16-consolidated-services.json), [execution plan](docs/workflow-monitoring-plan.md) |

Earlier fresh-image workflow regression (historical): 73 service tests and 152 Hermes tests passed;
one optional Docker security fixture was skipped. Real local Connect outages,
crash-after-effect recovery, legacy rollback, privacy and inactive restore passed. These synthetic
checks do not replace the live acceptance below. No legacy persisted-data migration is required;
VPS work remains deferred.

<local_inngest_cutover>

Historical seven-family checkpoint; the consolidation above completes all nine.

The active local installation has both Connect apps and nine connected family
registrations. Seven ownership switches used separate validated format-4 snapshots
and the pause/drain/reconcile protocol. The final snapshot before schedules contains
44 archive tables, 14 Inngest tables and 430 protected files. The live history scan
checked 2,521 rows for five internal credentials and synthetic source/tool markers;
none appeared. Owner-only Inngest history loads with its inspection-only banner.

- [Infrastructure](compatibility/results/2026-09-14-inngest-local-infrastructure.json)
  and [imports](compatibility/results/2026-09-14-inngest-local-imports.json).
- [Controlled tools](compatibility/results/2026-09-14-inngest-local-tools.json)
  and [approved-message denial](compatibility/results/2026-09-14-inngest-local-actions.json).
  The first tool canary encountered a missing sandbox image and stays closed as
  uncertain. After building the pinned image, a distinct approved canary passed.
- [Memory consent/retry preservation](compatibility/results/2026-09-14-inngest-local-memory.json)
  and [detached Honcho ownership](compatibility/results/2026-09-14-inngest-local-honcho.json).
  Four existing failed memory reviews retain their retry deadlines. A new browser
  review subsequently completed on its first attempt. Honcho was unattached at that
  cutover; production activation is recorded below.
- [Browser streaming/replay/cancellation](compatibility/results/2026-09-14-inngest-local-browser.json)
  and [native schedule wait/edit/pause/occurrence](compatibility/results/2026-09-14-inngest-local-schedules.json).
  The guard masked the browser's identifier-like test marker; its response matched
  the guarded input. Schedule output stayed local and created no delivery proposal.

Earlier implementation evidence covers the
[foundation](compatibility/results/2026-09-12-inngest-foundation.json),
[outbox](compatibility/results/2026-09-12-inngest-outbox.json),
[job operations](compatibility/results/2026-09-12-inngest-job-operations.json),
[Telegram](compatibility/results/2026-09-12-inngest-telegram.json),
[memory](compatibility/results/2026-09-12-inngest-memory.json),
[imports](compatibility/results/2026-09-12-inngest-host-imports.json),
[approvals](compatibility/results/2026-09-12-inngest-approved-actions.json),
[tools](compatibility/results/2026-09-12-inngest-host-tools.json),
[browser](compatibility/results/2026-09-12-inngest-browser.json),
[schedules](compatibility/results/2026-09-12-inngest-schedules.json),
[Monitoring](compatibility/results/2026-09-14-inngest-monitoring.json),
[atomic migration](compatibility/results/2026-09-14-inngest-cutover-core.json) and
[host handoff](compatibility/results/2026-09-14-inngest-host-handoff.json).

</local_inngest_cutover>

<shared_provider_login_acceptance>

[Fresh login evidence](compatibility/results/2026-09-14-shared-provider-login.json)
records the active installation's synthetic provider and speech checks, owner-session
and cross-site rejection, connected Telegram polling and nine workflow registrations.
No external owner messages or controlled actions were sent. The single embedding
attempt failed with HTTP 429, and the temporary meter was stopped afterwards.

Honcho status now reads CPA's single-login state instead of its retired bridge-auth
folder. Its dashboard label is **Shared ChatGPT login**. The internal key aliases
identify Hermes assistant replies, Honcho long-term memory and content privacy
preparation. This display fix does not activate provider routing or memory.

The offline Hermes suite ran 153 tests (151 passed, two optional skips), ten focused
host tests pass, and six targeted owner/OAuth/workflow checks pass (one live fixture
check skipped). The build passes and Graphify was refreshed without model calls.
The new label was inspected in the existing isolated preview; its unrelated primary
memory panel lacks fixture support and is not claimed as a full live-memory pass.

The owner subsequently approved [S5 local cutover](compatibility/results/2026-09-14-shared-provider-cutover.json).
A validated format-4 backup contains 44 archive tables, 14 Inngest tables and 494
protected files. Text, literal detection and transcription pass through Hermes;
chat continues during monitor shutdown; text and transcription pass again after
restarting CPA, speech, Hermes and monitoring. The native login is retired and the
saved/runtime route is `shared`, with CPA as refresh owner. Fifteen containers are
healthy, nine workflow registrations are connected, and Telegram polling is observed.
Honcho was detached during that cutover, which made no additional paid embedding request.

</shared_provider_login_acceptance>

<honcho_live_acceptance>

After the owner replaced the dedicated embedding key, the metered request returned
HTTP 200. [Fresh live acceptance](compatibility/results/2026-09-14-honcho-live-acceptance.json)
passes shared subscription reasoning, ingestion, retrieval, guarded embedding
evidence, persistence and recall after Honcho restart, and failure/recovery across
a brief CPA outage. The archive accepted the report: `verified=true`, `attached=false`.
The isolated Honcho services are stopped with their database and ledger preserved.
Pilot reservations total $0.07, including earlier failed requests; this is a
conservative reservation total, not an invoice.

Fresh live Hermes text, privacy detection, transcription and refresh-ownership
checks pass. All 73 service regressions and 19 Honcho tests pass. The offline Hermes
suite ran 153 tests: 151 passed, with the optional Docker security fixture and the
deployment-source check skipped. Missing host test dependencies and a read-only
test build-output mount were corrected before those suites passed. Fifteen active
containers are healthy, Telegram polling is connected, and all nine workflow
registrations are connected. The service test fixture was stopped after verification.

Production Honcho attachment and scoped ingestion/recall were pending at this
stage and subsequently passed as recorded below. Opted-in history and monthly-cap
activation remain pending. This earlier run did not repeat
backup/restore or real owner Telegram acceptance. Only documentation and safe
evidence changed, so the AST graph does not require rebuilding.

</honcho_live_acceptance>

<honcho_production_activation>

The owner authorized production activation and a graceful OrbStack restart on
2026-09-15 local time. The validated pre-activation format-4 snapshot preserves
44 archive tables, 14 Inngest tables and 524 protected files. Honcho is attached
and verified; history backfill and catch-up are disabled.

The first scoped production recall returned limited memory. The verified and
installed correction gives Honcho recall an eight-minute upstream deadline, ten
minutes through the scoped broker and 615 seconds in the native tool. Ordinary
archive reads retain their shorter deadlines, and broker cancellation still
aborts its upstream request. Both candidate images build; all 74 service tests and 152 Hermes
tests pass, with two optional Hermes checks skipped. The earlier 23 focused
Python checks passed; Graphify was refreshed using AST extraction only.

[Production acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json)
passes consented ingestion, derivation, scoped owner recall, actual Hermes memory
tool use through the security broker, group isolation, and exclusion of the
unconsented source. Synthetic imports produced no replies. All five Honcho
services were stopped and restarted: outage fallback reported limited memory,
then recall passed again with the same event, generation and receipt identities
and exactly one ingestion attempt. The native tool also passed with the other
project running again after the shared engine restart.

Fresh shared-login text, privacy detection, transcription and refresh-authority
checks pass. One CPA login is present, Telegram polling is connected, and all nine
workflow registrations are connected. The 15 main containers are healthy; four
Honcho services have passing healthchecks and the deriver is running without a
standalone healthcheck. All five Honcho services use unless-stopped. The isolated
test fixture is stopped with its state preserved.

Embeddings use text-embedding-3-small with 1536 dimensions and the existing $5
pilot cap. Reservations are conservative, not a provider invoice; the final
amount is recorded in the acceptance evidence. Monthly activation and historical
learning remain separate. Real owner Telegram acceptance remains pending, so
preparation and Telegram ownership are still legacy. The full release is not
accepted by these synthetic checks.

</honcho_production_activation>

<telegram_live_latency>

The first real owner text turn after Honcho activation completed once, but took
128.1 seconds from archive capture to its runtime receipt. The source was prepared
in 4.9 seconds, Honcho recall took 26.0 seconds, and two actual reply-model calls
combined took 9.5 seconds. Context preparation, native memory/tool processing,
startup and waits account for the remainder; exact attribution still needs more
instrumentation. Twelve provider calls were observed in the turn window, all
successful. Later shared-engine load cannot establish its contribution to that
specific turn.

The owner's follow-up was captured 270.4 seconds after its Telegram timestamp
and then closed as ambiguous with dispatch_interrupted on its first attempt,
with no recorded model request. Background native memory review overlapped it;
profile contention is a hypothesis because the persisted exception is generic.
No replacement execution or send was started. Real Telegram acceptance is failed,
so preparation/Telegram cutover and release remain blocked on diagnosis, fixes,
and a repeated owner test. The earlier isolated Honcho checks are historical
passes and do not establish full-chat latency or follow-up reliability.

[Content-free timing evidence](compatibility/results/2026-09-15-telegram-latency-diagnosis.json).

Profile admission now shares the native review/conversation lock. Foreground turns
wait before child execution and recheck cancellation and current policy; a busy
review returns to prerequisite waiting without consuming an attempt. Legacy
Telegram ownership uses the asynchronous runtime receipt contract and reconciles
running identities before any repeated start. All 74 service checks pass in the
isolated Compose fixture with serial test-file execution; six focused admission
checks pass. The initial parallel service run hit database timeouts. The broader
Hermes run passed 151 checks with two existing skips, but three native startup
checks timed out under host load. The final candidate subsequently passed all 155 non-optional Hermes checks across the full
run and a solitary repeat of its one timing-sensitive TUI check; two existing
optional checks are skipped. The code is installed locally; real Telegram acceptance still needs a new owner
message and the remaining live gates.

Guard context persistence now batches the cache reads, prepared-value inserts,
and one atomic write per bounded detector batch. A 100-fragment regression proves
exact originals/guarded outputs, cached reuse, fewer than 30 database statements,
and rollback without partial trust. All 21 affected privacy, recovery, broker,
policy and memory checks pass. Native phase timings use fixed names and numeric
counts/durations only; Telegram health separates network and spool-write timing.
Profile preparation, session cursor writes and dispatch/action receipt writes run
off the polling event loop while retaining their fsync-before-delivery ordering.

Current host pressure was measured at about 92% CPU use, 15 GB RAM used and 6.6 GB
compressed. This is current evidence, not proof of the original capture delay.
The separate project was left running; the synthetic fixture is stopped again.
Both verified images are installed after pausing admission and observing no
active reply, review, browser turn or action. Admission is restored with all owner
and epoch values unchanged; rollback tags and compatible receipts are preserved.
The eight replaced services passed health checks. Fresh shared-login text, guard,
transcription and refresh-authority probes pass, and native polling is connected.
The first text probe took 58.079 seconds, versus 4.285 seconds for its repeat;
cold startup remains slow. These are synthetic runtime probes, not full Telegram
latency measurements. No old ambiguous turn was replayed. Graphify was refreshed
with 253 files and no model calls.

[Installed response-fix evidence](compatibility/results/2026-09-15-telegram-response-fixes.json).
The owner should send one fresh private follow-up so the new runtime receipt and
phase timings can establish real delivery and remaining latency.

The next two real owner messages were captured within 1.497 and 2.581 seconds,
and each completed once on attempt one, but capture-to-receipt still took 143.043
and 141.018 seconds. Both replies carried a limited-memory notice. Profiling found
that the pinned native OpenAI client imports the optional Bedrock adapter, which
tries to install missing dependencies and spends 30.842 seconds on blocked
installation. Sealing managed-turn dependencies reduces synthetic native agent
construction from 41.088 to 4.378 seconds. Native reasoning, memory, tools and the
external guard remain enabled.

Honcho had four completed source receipts and no pending or running derivation,
but its generation remained building: the first readiness observer had completed
before later uploads. Transactional receipt creation and acknowledgment now request
fresh read-only observations without reopening an ingestion receipt. Background
native review overlapped the second turn and held its profile; reviews now wait
for a 60-second quiet interval after foreground activity, without consuming an
attempt or replacing a native receipt. All 75 service checks passed. All 157
non-optional Hermes checks passed across the full run and an isolated repeat of
three startup checks that timed out under shared-engine load; two optional checks
were skipped. Both tested images are installed locally; all eight replaced
services are healthy, native Telegram polling is connected, and admission is
restored with ownership unchanged. A new Inngest readiness observation completed
without changing the four ingestion receipts or their single attempts. Fresh
scoped owner recall returned the expected answer with limited_memory=false in
34.544 seconds. Paid embedding reservations total $0.24 of the existing $5 pilot
cap. This verifies recall, not the final Telegram response time: a new owner
question and immediate follow-up were requested; their later results follow below. Local main
contains code commit 9ea9fc2; GitHub HTTPS authentication still blocks remote push. [Follow-up evidence](compatibility/results/2026-09-15-telegram-followup-fixes.json).

The owner's next question and immediate follow-up both completed on attempt one.
Capture lag was 0.731 and 1.461 seconds; capture-to-receipt was 89.028 and 82.829
seconds. Native agent initialization fell to 2.332 and 1.589 seconds, while
Honcho recall still took 27.340 and 47.481 seconds. The second reply incorrectly
reported limited memory during an incremental synchronization that completed six
seconds after recall returned. Six source receipts were done; prior usable memory
had not been retired. The adapter now records whether the current authorized
generation has ever reached readiness and reports synchronization separately.
Initial builds, retired generations and failed recall still disclose limited
memory. All 75 service checks and ten focused checks passed; the final three Honcho
and workflow-memory checks passed after adding explicit retired-state coverage.
All 157 non-optional Hermes checks passed across the full run and a repeat of
one TUI startup check that missed its deadline; two optional checks were skipped.
Both code increments are merged locally (f3ba380, 0931255); GitHub HTTPS
authentication still blocks remote push. Candidate installation awaits explicit
approval: automatic approval review rejected pausing admission across all nine
families as broad service-disruption risk. That command did not execute and
active images/admission were not changed.

The memory query omits the per-execution archive footer while the full native
agent prompt retains its source reference. A candidate image also precompiles
the pinned Python modules. Its startup benchmark was stopped during severe host
load (load average 104.50), without a valid timing result. A later bounded
offline comparison measured 44.621 seconds for the previous image and 17.656
seconds for the candidate; changing shared host load limits attribution. These
are synthetic startup timings, not Telegram delivery acceptance. The isolated service
test stack was stopped; unrelated services were left running. Three active
Nocheh services had restarted, with Docker reporting no OOM kill at inspection.

The owner reaffirmed ADR-0033: Honcho is the primary long-term memory and Hermes
keeps small native notes. The earlier use of "hybrid" referred to native Hermes's
combination of automatic context and recall tools, not a different memory-backend
decision. The latency recommendation is to provide Honcho context automatically,
reuse Honcho-provided context where valid, refresh it in the background, and use
deeper reasoning tools when useful. Small native notes remain complementary;
the recommendation does not make primary memory depend only on the agent choosing
a tool. It must preserve full authorized native context and enforce current
audience, source revisions and memory generations before any cache reuse.
Nocheh currently uses a guarded blocking recall adapter and manages memory.provider
itself; editing a native Honcho setting alone does not change that adapter. This
retrieval optimization is a recommendation, not an implemented or activated mode.
The blanket reasoning call remains a latency limitation.
[Accepted memory decision](docs/adr/0033-guarded-projections-and-honcho-memory.md).
[Native provider reference](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/honcho/README.md).

The standard services rebuild stalled resolving the pinned Node base metadata
and was cancelled. An offline candidate copies only the tested compiled Honcho
module onto the verified installed services image, with unchanged dependencies;
its module hash matches the test artifact exactly. The Hermes candidate built
from its normal pinned recipe. Both candidate image digests are recorded.

[Memory availability and startup evidence](compatibility/results/2026-09-15-memory-availability.json).

</telegram_live_latency>

## Outstanding acceptance and blockers

- **Subscription transcription:** final-image shared-login Ogg/Opus transcription passes. Real owner voice bytes, input hash, expected transcript and one completed reply are verified.
- **Telegram / release:** real text, voice, intentional group silence, scoped private-source denial, exact owner-approved delivery, and pending/completed receipt preservation across restart pass. The approved local consolidation is accepted; [release acceptance](docs/release-acceptance.md) remains the repeatable procedure.
- **Shared provider:** the owner explicitly approved the switch after the earlier testing-only rejection. S5 passed and the shared route is active; the old native login is privately retired. No provider cutover blocker remains. The refresh check verifies authority delegation, not a newly forced token-expiration event.
- **Honcho:** attached and verified; scoped production ingestion/recall, native-tool access, isolation, outage and restart acceptance pass. The opted-in history pilot and monthly budget cutover remain pending. Preserve the durable pilot ledger and explicit learning consent. See the production acceptance evidence above.
- **Space memory:** native-note/transcript filtering is not implemented; its provider-payload/destination extension was blocked by an earlier automatic approval review. Live native-review/filter quality and the browser policy-save check also remain pending. See [recorded boundaries](docs/space-memory-plan.md).
- **Remote synchronization:** each verified increment was merged locally under the shared Git lock; fetch and push repeatedly confirmed that local GitHub HTTPS authentication is unavailable. Local integration and remote push outcomes must be reported separately; do not infer synchronization from a local merge.

## Development follow-ups and proposals

- **Per-session previews — not implemented:** add explicit isolation of Compose projects, networks, image tags, ports, state, and credentials before concurrent worktree previews. No duplicate Telegram poller, scheduler, or OAuth refresh owner may use the active installation.
- **Makefile — not implemented:** `dev` is declared phony but has no recipe. Existing `./scripts/nocheh dev` runs the installation's Compose Watch workflow; it is not an isolated-session setup command. Wiring `make dev`, fresh-worktree setup, and visible persistent preview startup are follow-up tooling work.
- **Inngest — accepted implementation:** [workflow execution plan](docs/workflow-monitoring-plan.md), I1–I7. All nine families are active, legacy execution is retired, and the approved migration acceptance passes. Independent host recovery remains available; optional memory follow-ups are separate.

## Historical implementation records

The following entries are retained snapshots. Their old phase statuses, topology,
provider routes, and instructions describe their recording time. Use the current
sections above for status and SPECS.md/AGENTS.md for requirements and workflow.

<details>
<summary>Earlier phase reports and evidence</summary>

#### Main consolidation — 2026-09-11

The owner requested that all refactor work move to `main`.
[ADR-0039](docs/adr/0039-main-refactor-consolidation.md) separates that integration
from release acceptance. The memory branches are already ancestors of the rebuild;
their controlled-tools draft is superseded by the completed P5 implementation.
Legacy history remains preserved on `codex/legacy-nocheh`.

Final verification: 57 service tests and 125 Hermes tests pass; one optional Docker
security fixture is skipped. The service rerun exposed a database-wide memory
review lock shared with the live worker; it now follows the schema-scoped locking
used by the other preparation workers, with isolation and exclusion assertions.
[Integration evidence](compatibility/results/2026-09-11-main-consolidation.json).
Both temporary memory worktrees are retired. The superseded draft remains in stash
`f4e3bcee`; complete worktree archives, including ignored test backups, are preserved
under the ignored `data/worktree-archives/2026-09-11/` directory.

At integration, shared-provider login count is zero and the native subscription route
remains active. Provider cutover, Honcho activation and the remaining live Telegram
gates below stay pending. Inngest remains a proposal. Remote synchronization could
not be checked because GitHub HTTPS authentication is unavailable locally.

#### Telegram recovery and owner monitoring — 2026-09-11

Fixed a fatal native polling recovery that remained reported as connected.
The supervisor now exits on retryable fatal adapter failure for Compose recovery,
retains a safe incident and reports actual polling progress. The waiting real
Telegram update completed on its first attempt after recovery.

Monitoring is active in the owner dashboard: recent Telegram workflows, retries,
blockers, successes/skips, provider route/login and services. OAuth now uses a
temporary state-validated host callback at port 1455. A real login start reached
the OpenAI sign-in page; owner completion and shared-provider cutover remain pending.
57 service checks pass; 124 Hermes checks pass with two optional checks skipped.
[Evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json).
Inngest was evaluated; [migration is proposed](docs/workflow-monitoring-plan.md),
not activated. This repair does not complete the remaining release gates.

Security service: [SEC1–SEC5 complete; active locally](docs/security-service-plan.md).
Phased implementation and automatic per-phase commits authorized under ADR-0037.
Existing provider and Honcho activation gates remain separate.

### Shared CLIProxyAPI provider and monitoring (ADR-0035)

Owner-approved implementation plan: [shared-provider-plan.md](docs/shared-provider-plan.md).

| Phase | Actual status |
| --- | --- |
| S1 — Contract | Complete in the ADR/plan increment; implementation follows in separate commits |
| S2 — Shared provider service | Complete: pinned image builds, private per-client credentials and locked no-retry/no-fallback configuration; container health and 8 focused tests pass. Fresh proxy login remains a cutover gate |
| S3 — Hermes, voice and Honcho routes | Complete: all reasoning clients use scoped shared-provider keys; speech alone has read-only OAuth access; 47 service, 101 Hermes and 13 Honcho checks pass. Fresh provider login remains a live cutover gate |
| S4 — CPA Manager Plus dashboard integration | Complete: pinned Full Mode image, isolated SQLite state, owner-session/CSRF proxy and browser UI pass; real service rejects unauthenticated access and exposes no provider secrets |
| S5 — Local acceptance and cutover | Acceptance command and recovery-safe backup/restore implemented; fresh provider device login and live cutover currently pending |

The native Hermes subscription route remains active until the candidate shared route
passes its live checks. Honcho attachment remains gated by its separate embedding and
memory acceptance; the recorded HTTP 429 is still pending.

#### Unified local Compose project — 2026-09-10

ADR-0036 places the native dashboard service in the main `nocheh` Compose project.
Complete: lifecycle tests, 47 service tests, 107 Hermes tests and a no-cache rebuild
pass. Docker reports one `nocheh` project with 10 healthy services, including the
native dashboard and optional database viewer. The old `nocheh-dashboard` project
is removed. The owner management server remains host-managed and healthy.

### Guarded projections and primary Honcho memory (ADR-0033)

Owner-approved replacement plan: [guarded-memory-plan.md](docs/guarded-memory-plan.md).
These phases are distinct from the earlier runtime-platform phases below.
Commits: G1 `7d474a1`, G2 `c99d324`, G3 `c22c50e`, G4 infrastructure `9194ed7`,
G5 `c84369a`, G6 `3e671e1`, G7 local acceptance `96bf60d`.

| Phase | Actual status |
| --- | --- |
| G1 — Durable guarded versions | Complete; 42 JS/TS checks and 91 pinned Hermes Python checks passed at this increment |
| G2 — Owner dashboard editor | Complete; owner API, conflict/race tests and synthetic browser edit/history/restore pass |
| G3 — On/off throughout | Complete; 45 JS/TS and 94 pinned Hermes checks passed at this increment; activated locally in G7 |
| G4 — Live Honcho connection | Pinned images build and isolated Compose startup pass. Shared subscription reasoning is implemented under ADR-0035. One synthetic request to the dedicated paid embedding route returned HTTP 429, so memory attachment remains pending |
| G5 — Primary Honcho memory | Implemented; 46 JS/TS and 94 Hermes checks pass. Attachment remains gated by G4 live acceptance |
| G6 — Edits, switching and recovery | Implemented; 47 JS/TS and 94 native checks pass. Portable owner revisions, inactive recovery, generation invalidation and optional catch-up verified with fixtures |
| G7 — Local acceptance and final graph | Guarded workflow passes live subscription recall, dashboard editing and restart. Backfill: 439 ready, zero pending/failed. Final 47 JS/TS, 94 Hermes and 12 Honcho fixture checks pass. Real Honcho activation and opted-in history pilot remain pending G4 credentials/gates |

G7 [local acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json)
and [live guarded recall](compatibility/results/2026-09-09-guarded-copies.json).
The [current system graph and instructions](docs/guarded-memory-system.md) distinguish
the shared reasoning implementation from the pending Honcho memory activation.
Hermes retains its tested native route until the ADR-0035 live cutover passes.
Under [ADR-0034](docs/adr/0034-explicit-embedding-environment.md), `.env`
now has an owner-supplied `OPENAI_API_KEY`, provider `openai`, and model
`text-embedding-3-small`. Configuration, redaction and spending checks pass: 15 pinned
Honcho and 94 Hermes tests. The [live embedding attempt](compatibility/results/2026-09-09-openai-embeddings.json)
returned HTTP 429 and retained a $0.01 reservation. The former separate bridge login
has been replaced by the one shared provider login; memory attachment remains disabled
until both shared reasoning and the dedicated embedding gate pass. Original G7 evidence
above is a historical snapshot from before the embedding credential was supplied.

G1 evidence: isolated PostgreSQL covers byte preservation, duplicate/concurrent capture,
restart, partial detector failure recovery, derived text and consent separation. Host
suite setup failures were resolved using explicit fixture DB credentials and the pinned
Hermes image. AST graph refreshed without model calls.

### Rebuild progress

Memory/privacy work is tracked separately in [space-memory-plan.md](docs/space-memory-plan.md)
and ADR-0030, on the isolated `codex/memory-space-policies` worktree.

#### Owner dashboard extension — 2026-09-07

Accepted [dashboard/CLI plan](docs/dashboard-cli-plan.md), ADR-0025. Each increment
is committed separately; these do not replace the production release gates below.

| Increment | Actual status |
| --- | --- |
| D1 — Compatibility and configuration | Complete: native preferences persist, validated config show/set/apply with redaction/conflict/recovery; 12 configuration/scope tests plus one pinned dashboard auth/extension test pass |
| D2 — Dashboard and import jobs | Complete: local native dashboard extension, shared owner API, settings, archive search and durable manual imports; 16 TypeScript tests and 39 pinned Python tests pass |
| D3 — Native memory and isolated Honcho CLI | Pending |
| D4 — Source graph and operations | Pending |

D1 also built the pinned upstream dashboard frontend successfully from its npm
lockfile in a temporary directory. Packaging and serving it are D2 work. No live
provider requests or production setting changes were required for D1 verification.

D2 [dashboard instructions](docs/dashboard.md). The local browser renders live
archive status, redacted settings and upload controls. HTTP acceptance verifies
unauthorized/cross-site rejection and cancellation/restart/resume using isolated
fixtures. ZIP traversal/symlink and changed-export failures pass. Existing real
PostgreSQL import/export tests verify exact originals and silent replay. Native
agent/mutation routes are denied at the dashboard ASGI boundary. Production
Telegram/provider configuration was not changed by these dashboard checks.

After the requested reset on 2026-09-07, a fresh Compose runtime was started with
the supplied Telegram bot token and owner/group IDs in the ignored `.env`.
All five services are healthy. Fresh Hermes sign-in and live subscription checks
pass. Telegram is enabled: the owner's real `/start` was captured, dispatched and
answered with confirmed Telegram delivery. Four real text messages in the selected
group were also captured and answered; no batch of older history arrived.
An optional read-only pgweb browser is available with `./scripts/nocheh db`.
The rebuild is **not released**: remaining Telegram acceptance and cutover are
pending. Main consolidation was authorized separately on 2026-09-11 under ADR-0039.

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. The refactor from
`codex/hermes-rebuild` is consolidated into `main` under ADR-0039.
No legacy data migration is required. VPS work is deferred by ADR-0019.

| Phase | Actual status |
| --- | --- |
| 0 — Preserve baseline and architecture | Complete: `add2341` |
| 1 — Subscription compatibility | Complete locally: `8fd69cc` |
| 2 — Compose runtime | Complete: `9d72c32` |
| 3 — Durable capture and archive | Complete: `d29dbab` |
| 4 — Import, search, export, replay | Complete: `aa39e60` |
| 5 — Optional outgoing guard | Complete: `eb6d319` |
| 6 — Scoped assistant and voice | Implemented at `43eea5e`; real owner DM and four group replies pass; full group isolation/silence, voice, approval and reconnect checks pending |
| 7 — Honcho comparison, maximum $5 | Runnable harness at `2d27262`; live comparison pending separate credentials; optional |
| 8 — Operations, cutover, merge | Backup/restore implemented at `4efe7c3`; real Telegram gate and cutover pending; main integration authorized separately by ADR-0039 |

#### Last validation before the reset — 2026-09-07

- 14 TypeScript tests pass against real Compose PostgreSQL where required;
  30 Python native integration/operations tests pass. No main-suite skips.
- 21 subscription contracts pass with simulated transport failures. Five Honcho
  budget/scoring tests pass; no paid requests or live comparison occurred.
- Live subscription refresh, native chat, literal detection and Ogg/Opus
  transcription pass again after configuration and worker cleanup.
  [Latest report](compatibility/results/2026-09-07-cleanup-subscription.json).
- Native memory store, recall across process restarts and another-group isolation
  passed the [synthetic live rehearsal](compatibility/results/2026-09-07-assistant-memory.json).
  Recall reached 152 seconds in that run; it is not a latency guarantee.
- Required guard failure/retry/redirect tests pass. Native guarded chat passed
  again after cleanup with one required boundary attempt and no guard failures;
  the saved `auto` policy is restored. Earlier transient failures remain in the
  [historical guard report](compatibility/results/2026-09-07-guard.json).
- `.env` configuration checkpoint `4f3fade` preserves archive credentials and keeps
  Hermes OAuth in its native file. Format-2 backup/restore matched eight table
  fingerprints and 38 state files; five restored services were healthy and inactive.
  The rehearsal is stopped. [Report](compatibility/results/2026-09-07-environment.json).

#### Cleanup and behavior fixes

The retired application is recoverable on the legacy branch. Its remaining local
`web/` build output and dependencies were removed. Active documentation describes
this runtime; historical research and accepted ADRs remain available.

Edit only the ignored root `.env` for local configuration. The requested fresh
reset removed the entire `data/` directory, including previous configuration,
archive files, backups, experiment state and the dedicated Hermes login.
Committed synthetic evidence and historical decisions remain in Git.

Archive capture, attachments, assistant work and approved actions progress in
independent non-overlapping loops. Slow inference cannot block capture/downloads.
Committed media avoids native duplicate downloads and unscoped sticker vision;
round video notes use the transcript path. Malformed source messages remain
archived with a visible suppressed dispatch and do not starve subsequent work.

#### Remaining release gates

The first real owner-DM capture and reply passed after enabling the gateway.
Fresh subscription refresh, chat, detector and Ogg/Opus checks also passed.
[Content-free live evidence](compatibility/results/2026-09-07-telegram-dm.json).
Selected-group membership and send permissions now pass; membership events are
archived. [Access evidence](compatibility/results/2026-09-07-telegram-group-access.json).
After the earlier privacy-mode check, four ordinary owner-authored group messages
were delivered and answered. This proves those messages' capture/replies, not
visibility of every group member's messages. Credentials and IDs are already saved
locally. Follow [Telegram setup and acceptance](docs/telegram.md).
Intentional group silence, private/group isolation, voice persistence,
owner-approved delivery and reconnect/restart checks remain **unrun**.
Container health does not prove these.
The original restriction on merging was superseded by ADR-0039; these release checks remain separate from Git integration.

#### Local inspection and latency — 2026-09-07

The [pgweb browser](docs/database-viewer.md) is running on loopback port 8782.
UI queries and PostgreSQL read-only privileges were verified, including a denied
zero-row update after disabling transaction read-only mode.
[Viewer evidence](compatibility/results/2026-09-07-database-viewer.json).

Four observed group replies took 16.55–35.17 seconds after archive receipt.
Capture was about one second after Telegram's source timestamp. The slowest turn
spent about 1 second queued, 4 seconds preparing Hermes, 28 seconds in the agent
phase (two model rounds, two archive searches), and 2 seconds completing delivery.
Archive searches themselves took about 0.1 seconds. Per-turn process startup,
serial assistant dispatch, and non-streamed responses remain latency limitations.
The trusted ChatGPT route bypasses guard detection under `auto`.
This diagnosis does not claim a performance fix or a completed release gate.

The optional Honcho experiment used the shared reasoning login and an explicitly
supplied dedicated embedding key. Its live comparison was not completed; the
historical decision is preserved in [ADR-0022](docs/adr/0022-isolated-metered-honcho-experiment.md).

##### Owner dashboard D3 — native memory and isolated Honcho CLI

- [x] Owner-only profile enumeration, bounded native notes and paginated SQLite
  session inspection; selected profiles cannot open another profile's session.
- [x] Native preference forms use the shared revision-checked resolver.
- [x] Official Honcho CLI 0.1.4 and SDK 2.4.0 pinned in a separate internal-only
  runner; stored data commands, JSON output, pagination, lifecycle aliases and
  honest unavailable dashboard state. Read lookups cannot create records.
- [x] Compose regression: 16 TypeScript tests and 41 Hermes integration tests;
  two CLI boundary tests and one real upstream CLI/SDK fixture test pass.
- [x] Production Honcho live compatibility and attachment are recorded above; the historical optional comparison was retired.

##### Owner dashboard D4 — evidence graph and operations

The owner's 3D graph revision replaces fixed SVG columns with a local Three.js
space, deterministic spatial layout, orbit/pan/zoom, node search, direct-connection
highlighting and source inspection. See ADR-0026 and the dashboard instructions.
This presentation change does not advance the pending production release gates.
Verification: nine graph/layout/failure tests, two owner HTTP tests and two pinned
dashboard compatibility tests pass. Live desktop and 375px browser checks cover
node picking, original sources, orbit/zoom, search, scope pagination and full screen.

- [x] Deterministic graph over one archive scope, with cursor pagination, original
  chat identities, author/reply/revision links, files, derived provenance and
  explicit native-note citations. No model calls or graph database.
- [x] Interactive keyboard-accessible graph, source detail, original file download,
  graph JSON and portable archive ZIP export.
- [x] Durable jobs for diagnosis, backup, restart and inactive restore; generated
  destinations, operation exclusion, and no preference writes during inspection.
- [x] Regression: 17 TypeScript and 43 pinned Hermes integration tests pass,
  including graph scope/provenance and operation failure/concurrency paths.
- [x] Local dashboard acceptance: graph node opens original source; diagnostics
  healthy; backup/restore verified all 8 tables and 89 state files with credentials
  inactive; portable ZIP exported 65 records with manifest/count/integrity checks.
- [x] Browser-native authenticated ZIP download verified; download-only HttpOnly
  cookie cannot access settings, and cross-origin downloads are denied.

##### Owner dashboard clarity — 2026-09-07

- [x] Navigation grouped into Explore, Manage and Experiments, with purpose text
  and an overview explaining Nocheh's controls and native Hermes responsibilities.
- [x] Separate Nocheh settings and per-profile Hermes preferences; clear save/apply
  timing, masked credential review, and empty secret edits preserve the saved value.
- [x] Three-step import guidance, read-only memory explanations, readable Honcho
  status and maintenance results, with technical details collapsed by default.
- [x] Browser acceptance covers navigation, unchanged native preference save,
  masked credential review/discard, diagnostics and responsive layout. Build and
  owner-management HTTP regression pass; AST-only code graph refreshed.

##### Nocheh runtime platform (ADR-0027)

Accepted [seven-phase plan](docs/runtime-platform-plan.md). Complete and verify each
phase, commit separately, then continue automatically. Existing release gates above
remain active. This direction supersedes the earlier Hermes-hosted presentation.

| Phase | Actual status |
| --- | --- |
| P1 — Ownership and runtime adapters | Complete: cbe3022; 30 JS/TS and 44 Python tests pass |
| P2 — Independent Nocheh dashboard | Complete: 1438674; independent root, native return page, desktop/mobile and 3D graph pass; 32 JS/TS and 44 Python tests pass |
| P3 — Configuration and native administration | Complete: 67d6a05; actual native state, shared config revisions, preference inheritance, scoped sessions/files and private profile management; 32 JS/TS and 52 Python tests pass |
| P4 — Native browser chat | Complete: 4effeac; isolated managed turns, original/file capture, native resume/cancel, scoped reconnect, durable receipts and Activity; 33 JS/TS and 64 Python tests plus live owner-private browser chat pass |
| P5 — Controlled broader tools and approvals | Complete: 75f7c39; exact approvals, bounded/revoked permissions, isolated shell and offline browser, public HTTPS MCP; 39 JS/TS + 78 Python full-suite and 16 targeted follow-up tests; live UI/CLI/worker acceptance passes |
| P6 — Native cron | Complete: 725983b; native editor and CLI, one supervised scheduler, durable fires/results, explicit catch-up, cancellation and local delivery; 40 JS/TS + 86 Python tests and live native scheduled subscription turn pass |
| P7 — Compatibility and release acceptance | Tooling verified and committed in the P7 increment: candidate runtime/native/UI builds, portable archive + memory export, inactive recovery with all 18 tables and 175 state files preserved across restart; 41 JS/TS + 91 Python tests and 2 host management checks pass. Real Telegram gates remain pending |


##### P7 operations evidence — 2026-09-08

[Content-free report](compatibility/results/2026-09-08-runtime-platform-operations.json).
The native candidate builds and tests with no live state, credentials or test
network. UI/CLI export verified 135 sources and two native SQLite databases. The
current archive had no attachment or native note files; synthetic tests verify
those byte-preservation paths. Full backup and inactive restore preserve all 18
tables and 175 state files. Restored workers, tools, scheduler and copied OAuth
remain held; table fingerprints survive restart unchanged. The rehearsal is stopped.

The first cache-link backup and closed-SQLite export failures are retained in the
report; both were fixed and successfully repeated. No Telegram test messages were
sent. P7 **release acceptance remains incomplete** until the owner supplies the
[remaining Telegram test inputs](docs/release-acceptance.md). Cutover remains
pending. ADR-0039 subsequently authorizes main integration without waiving those
release gates.

</details>
