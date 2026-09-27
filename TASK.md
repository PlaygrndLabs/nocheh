# Nocheh implementation status

This is the current status ledger, last reconciled on 2026-09-27. [SPECS.md](SPECS.md)
defines the intended product; [AGENTS.md](AGENTS.md) defines working rules.
[Status history](docs/task-history.md) summarizes completed and superseded work.
The previous ledger is summarized in task history; its dated claims are historical, not current acceptance. Git commit IDs may change during the privacy history rewrite.

Historical result files were removed because they held live operational identifiers and private material. Their prior links are now removal notices; a claimed live pass that depended only on those reports needs fresh local-only evidence before release. Git-history removal and remote verification are still pending.

## Release decision

**MVP release acceptance is not established.** The tested code is integrated into
local `main`. The controlled reset erased the reviewed old scope, initialized
`original-only-v1`, and passed the empty baseline after the owner approved removal
of 19 historical admin files. The owner then directed removal of old archive and
memory data while retaining auth/settings and rebuilding the app. Six runtime
images rebuilt, the one-time Telegram backlog discard was confirmed, and all 17
services started healthy in fresh acceptance mode with restart ownership off.
The post-reset owner voice and intentional group-silence checks passed. The
owner then retired the stopped operating installation after its archive and one
original were copied into `nocheh-dev`. Its containers, networks, volumes, and
ignored local state, including provider logins, were removed. The owner authorized
restoring that retained copy into a new local operating stack. The archive's 92
events, two artifacts, one hash-verified original, and Honcho's zero messages
were verified after restoration. The shared provider cutover passed its live
subscription checks, Telegram is connected, and two forum-topic messages were
captured with the bot verified as an administrator. A current two-topic live
question stayed within its own topic, and a human reaction add/change/removal
on the source message ended in an empty current state with no reaction reply.
Relevant equivalence for the previous operating installation's passed
observations is recorded. The owner correction is saved at active revision 3;
corrected active recall, reaction-derived meaning, and reset-specific gates
remain pending. The exact revision 3 Honcho projection is complete.

| Area | Last established state | Remaining gate |
| --- | --- | --- |
| Candidate code | The 2026-09-24 isolated gate passed 137 Node/dashboard checks (46 fixture skips), database-loss recovery, and 358 native Hermes tests (three skips). Later dashboard, reset-refresh, dispatch recovery, and answer-guidance increments passed focused checks and reached local `main`. The one-action Archive UI is active. The final exact-order answer image has no entrypoint override, retains the normal Hermes command, and passed 368 pinned native tests (three skips); the running installation uses it. A fresh live turn delivered the intended conservative answer once, and the owner confirmed that one reply was visible. A retired-content answer guard now passes focused tests in a candidate image. A broad offline run completed 370 tests with three skips and one intermittent native TUI assertion; that assertion passed alone. The retired-content image is active through a fifth journaled Hermes-only replacement; a fresh owner-visible reply passed with one linked delivery and the intended conservative answer. | Complete the remaining live gates; code and image activation alone do not establish release acceptance. Earlier gate (report removed for privacy), prior refresh evidence (report removed for privacy) |
| Message retirement and reactions | Owner-only, revision-checked retirement and current reaction state are implemented. A post-reset owner message was retired before delivery, its dispatch was cancelled, and the owner saw no reply; undo restored the source without restarting that dispatch. A later timing attempt was retired only after its reply and did not count. The clearer one-action Archive control passed build, focused tests, and isolated visual interaction, then became active through a dashboard-only reset-journal replacement. The owner then sent a fresh private message and retired it nine seconds after capture. The saved owner decision reached revision 1 before any assistant attempt; dispatch ended cancelled with zero linked delivered receipts. The owner confirmed the live Archive displayed “Retired from Nocheh” with Undo and no Telegram reply appeared. The original remains preserved. A later follow-up completed after eleven attempts with one linked reply. Its saved runtime contexts and reply omitted the retired topic, but the owner-visible answer falsely identified the current question as the retired source. The conservative answer fix is active, and a fresh one-attempt live turn passed: its context excluded the retired topic, its one linked reply used the intended answer, and the owner confirmed exactly one matching visible message. The exact-order answer guard separately passed one linked and owner-visible live reply. A human's individual reaction add/change/removal reached the archive; final current state is empty and no reaction turn replied. A later named-forum-topic human add/change/removal targeted the owner's source message; the final state was empty, all reaction dispatches were suppressed, and no reaction-triggered send occurred. The owner-authored question in the other named topic received one linked reply stating that topic's signal was unavailable. The source topic separately received an acknowledgment containing its own signal. | Establish derived reaction meaning and active recall; diagnose transient `unexpected_profile_tool` failures before release. Forum evidence (report removed for privacy), [procedure](docs/release-acceptance.md) |
| Running installation | The retained archive, Honcho database, and one owned original were restored into the `nocheh` stack. Both copied database logins were rotated; 92 archive events, two artifacts, the original hash, zero Honcho messages, and 17 healthy services were verified at restoration. One fresh provider login passed shared-route cutover, and Telegram connected to the retained group plus the new forum group. Prior passed observations have a recorded relevant-equivalence check. App revision `dedc2cd` and its Hermes correction guidance are active locally with all 17 services healthy and workflows connected. | Complete unpassed live and memory gates before release. The old reset journal's post-boundary validator remains separate. Restore (report removed for privacy), equivalence (report removed for privacy), Honcho acceptance (report removed for privacy) |
| Storage transition | The exact 13 reviewed external erase items are absent; all three unrelated items retain their device/inode identities. The 1,974-entry file manifest was processed, and the exact 17 old containers and three old volumes were removed. Saved setup, credentials, provider accounting, native preferences, and Honcho spending verified as retained. The owner approved retirement of 19 historical admin artifacts by saved identity. Fresh archive and derived rows, Inngest and Honcho database relations and cache keys, and native original files all verified empty before the Telegram boundary. After startup, archive events remain zero; eight new derivative receipts record `deleteWebhook` intents/results, with no event-bound derivative. | Fresh content and memory release checks remain pending; ordinary post-boundary runtime activity can create new operational rows. [Plan](docs/original-only-archive-plan.md), evidence (report removed for privacy) |
| Live Telegram | Post-reset voice, intentional silence, private/group isolation, exact owner approval, a post-delivery restart, an in-flight restart with one visible reply, and an authorized human group exchange passed. Individual reaction add/change/removal updates arrived. A fresh source was retired before any assistant attempt with no delivered reply; the owner confirmed the saved Archive state and Telegram silence. The first adjacent-message answer failed accuracy; the corrected live rerun gave one conservative reply, confirmed by the owner. A new ordinary owner DM completed in one attempt with one linked delivered reply, and the owner confirmed it appeared once and was sensible; the dashboard confirmed the response link. Monitoring shows Telegram receiving. | The retired-topic future-recall check and current two-named-topic isolation check passed. The owner and forum conventions are learned, and the owner saved the intended correction at revision 3. Verify corrected active recall and derived reaction meaning; diagnose transient tool-registration failures and the voice delay. The fresh DM took about 172 seconds, and `unexpected_profile_tool` did not recur in that turn. DM evidence (report removed for privacy), forum evidence (report removed for privacy), correction (report removed for privacy) |
| Subscription transcription | The pre-reset quiet-note failure preserved its original and stopped automatic retry; a separate exact-phrase note passed before reset. The first post-reset owner voice note saved 12,524 original bytes with a matching SHA-256 manifest. Subscription transcription produced the exact release sentence in one attempt, the selected guarded copy preserved it unchanged, and one linked Telegram reply was delivered. | The post-reset exact-phrase voice gate passed. Continue the other fresh live acceptance checks. Post-reset evidence (report removed for privacy), quiet-note outcome (report removed for privacy) |
| Honcho | The local app now serves a time-bound guarded synthetic acceptance workspace. Fresh operating subscription reasoning, labeled-secret masking, embedding, synthetic ingestion and recall, API/deriver restart recall, and controlled provider failure/recovery passed. The session was closed; a later gateway request returned 403 without a new reservation. The $5 pilot ledger reserved $0.64 including the earlier $0.52 carryover. Verification was recorded, and Honcho was attached for new activity with history and catch-up off. Production generations reached ready state with context snapshots and completed source receipts; four learned entries exist, including the owner and forum conventions. The forum and owner correction revision 3 projection receipts are done. | Verify corrected active recall. Previously consented history and monthly-cap activation remain separate. Operating acceptance (report removed for privacy), correction (report removed for privacy) |
| Remote Git | Verified increments through the local development runner are integrated into local `main`. The local commits remain ahead of `origin/main`. An earlier GitHub HTTPS push could not authenticate; automatic approval review later rejected pushing live-test metadata to the unverified remote. | Remove live report blobs from all reachable history, verify the rewritten refs, then authenticate and synchronize the sanitized history. Report local and remote outcomes separately. |

The detached Honcho acceptance path passed the TypeScript build and focused
isolated PostgreSQL checks before the exact-revision local rollout. The operating
preflight and connection state are recorded above. [Decision](docs/adr/0068-detached-honcho-acceptance-workspace.md),
[procedure](docs/release-acceptance.md).

An owner synthetic convention DM was captured at 2026-09-27T12:37:07Z. Its first
assistant attempt failed with `assistant_runtime_unavailable` at 12:43:53Z; a
second attempt completed at 12:47:22Z with one linked reply. The Archive
dashboard showed that reply acknowledging the convention and disclosing limited
memory. Telegram visibility and learned interpretation remain pending. This
delay is a current release investigation, separate from the prior
`unexpected_profile_tool` error.
Content-free evidence (report removed for privacy).

A second owner synthetic convention DM was captured after Honcho attachment at
2026-09-27T13:20:48Z and produced one linked dashboard reply on its first
attempt. Its first source ingestion receipt completed, and the owner generation
became ready before a subsequent source write returned it to building. The
interpretation attempt failed because Honcho put its current session ID in the
conversation scope field. A focused fix accepts only that exact trusted session
alias, stores the evidence conversation scope, and rejects other IDs and
cross-conversation evidence. Build and focused parser checks passed. Revision
`4262cb7` is active on the local app with all 17 services healthy; the GitHub
push remains blocked by missing HTTPS credentials. The production Honcho
generation is ready with a fresh context snapshot and two completed source
receipts. The saved model result passed the deployed scope parser with one
canonical conversation interpretation. Its next workflow attempt then failed
`entity_attribution_mismatch`: a direct claim about the trusted source speaker
omitted the redundant speaker ID. A focused candidate fills only that omission
from trusted context and still rejects conflicting or reported attribution;
build and focused tests passed. It needs rollout and a fresh workflow attempt.
There is no learned entry or projection receipt yet. Owner correction, active
recall, and downstream reaction meaning remain pending.
Live evidence (report removed for privacy).

Revision `d24ac74` with the trusted direct-speaker repair is active on the
local app; all 17 services are healthy and the compiled fix was confirmed in
the running container. A new owner convention DM was captured at
2026-09-27T14:17:55Z in the same private scope. At the 14:39Z diagnosis it had no linked reply and its
Telegram, preparation, and source-learning workflows were still queued at the
then-latest observation. Their outbox events were published; Telegram and source
review each received one run, but preparation had none and stayed queued.
Telegram waited on the guard and source review waited on a receipt. The
registered workers were connected; 562 older source review workflows were
waiting. At the later diagnosis, 482 source workflows waited on a prerequisite
across only 63 distinct sources; 61 sources had multiple waiting generations,
with as many as 22 for one source. The fresh owner preparation still had no
run or linked reply at 14:39Z, over 21 minutes after capture. This is an
operating scheduler backlog and a release blocker. The prior violet job was
skipped after the guard epoch advanced from 30 to 31, so it cannot establish
learned publication.

The owner also stated a local 👍 convention in the selected forum topic at
2026-09-27T14:11:09Z. A non-owner human added 👍 to the earlier source message
in that same topic ten seconds later. Its individual reaction is the current
stored state. Derived meaning remains pending.
Current live evidence (report removed for privacy).

A targeted source-review backlog repair is active in local app revision
`53502ef` with all 17 Compose services healthy. The touch
operation closes idle predecessors, but a predecessor running at touch time
can later return to `waiting`; current control rows show that pattern across
many generations. Before rollout, exactly 550 rows matched the repair's safe idle
filter. The active worker retires bounded batches of idle superseded
source reviews without started or closed effect receipts and closes a
predecessor when it advances after a newer generation exists. TypeScript and
the runnable focused Node check passed. The database-backed fixture cases
remain unrun because the synthetic fixture must not share the host with the
operating Compose installation. A rollback-only temporary-table SQL check
passed. After rollout, the same read-only eligible-row query returned zero,
and 559 source reviews were recorded as superseded. The fresh owner DM now
has one linked reply and completed its first Telegram attempt, but its native
review became ambiguous after an unconfirmed runtime call. The forum reaction's
native review completed. At that observation neither had a learned entry.
GitHub push remained blocked by absent HTTPS authentication.
Repair evidence (report removed for privacy).

The same supersession race affected Honcho source workflows. A read-only control
query found 441 idle older Honcho source generations with a newer generation and
no started, completed, or ambiguous workflow effect receipt. Revision `a92b3f9`
extended the bounded startup retirement and advance-time guard to these source
workflows, preserving active leases and effect receipts. The TypeScript build and
runnable focused workflow check passed, and a read-only `EXPLAIN` parsed the
exact update. The isolated database fixture remains skipped under the one-stack
rule. The exact revision is active on the local app with 17 healthy services;
the eligible query returned zero, and 441 Honcho source workflows are recorded as
superseded. Four learned entries then appeared. The owner-private cobalt-star
convention and forum-topic 👍 convention have active revision 1 and provenance
to the expected synthetic source events. A completed Honcho projection receipt
exists for each forum and original owner convention. The owner saved the
intended correction as active revision 3. Revision 2 repeated the original
meaning and has been superseded. The corrected revision's workflow was queued
but had no Honcho receipt while the Inngest worker was disconnected. An ordered
restart of the workflow server and app restored the worker connection, and all
17 services were healthy; the revision 3 receipt and live recall remain pending.
The human reaction's contextual interpretation failed with `honcho_unavailable`
and then `honcho_upstream_rejected` under guard epoch 31; the current epoch is
33, so reaction-derived meaning remains pending. The corrected revision 3
Honcho projection receipt completed in one attempt. The first owner recall DM
then failed: one linked reply used the superseded meaning, even though its
saved Honcho result included the correction. The forum question reposted in the
same named topic completed in one attempt with one linked reply that correctly
explained the older 👍 item as done. Scoped active-owner-correction recall is
now active on the local app and Hermes image with 17 healthy services and
workflows connected; a fresh owner DM remains pending. A fresh current-epoch
reaction job failed `unavailable_interpretation_evidence` because the model
cited a learned-entry ID as original source evidence. A narrow repair candidate
passed focused tests and parsed the saved failed result into one valid
trigger-citing interpretation without changing the original model output;
rollout and retry remain pending. The GitHub push of
live-test metadata was rejected by automatic approval review as
an unverified remote destination; earlier attempts also lacked HTTPS login.
Repair evidence (report removed for privacy),
current live evidence (report removed for privacy).

## Next actions

1. Repeat an ordinary owner-DM question after the active scoped correction recall repair. The first recall, event `[private acceptance identifier removed]`, delivered one linked reply but used the old meaning; the exact revision 3 Honcho projection receipt is done. Require a fresh one-linked-reply answer using the active correction. Current evidence (report removed for privacy).
2. After the owner recall turn completes, activate the narrow reaction interpretation repair and retry the preserved current-epoch job. The repair retains strict original-source validation and its local replay yielded exactly one valid interpretation citing the reaction. The first forum question landed in General and did not count. The repost in the matching named topic, event `[private acceptance identifier removed]`, received one linked and correct reply. The separate reaction interpretation still needs a guarded result. Current evidence (report removed for privacy).
3. Complete any reset-specific validator checks that still require current post-boundary IDs. Historical live observations may be carried forward only under the recorded relevant-equivalence rule. [Procedure](docs/release-acceptance.md), equivalence (report removed for privacy).
4. Investigate a future occurrence of `unexpected_profile_tool` using the bounded identifiers now saved in local dispatch receipts, and reconcile the earlier voice delay. Do not call the intermittent failure resolved from one successful turn. Timing evidence (report removed for privacy).
5. The local code and evidence commits are ahead of `origin/main`. Automatic approval review rejected pushing live-test metadata to the unverified remote, and earlier GitHub HTTPS attempts lacked credentials. Keep local and remote integration outcomes separate until that specific push is authorized and authenticated.

## Implemented areas and evidence

These are implementation checkpoints, not substitutes for the release decision above.

| Area | Recorded checkpoint |
| --- | --- |
| Runtime, dashboard, and controlled actions | P1–P6 and dashboard D1–D4 were implemented; P7 recovery tooling and earlier consolidated local acceptance passed. [Runtime plan](docs/runtime-platform-plan.md), operations evidence (report removed for privacy) |
| Archive reaction rows | Reaction additions, changes, removals, and anonymous count updates now have distinct owner-facing row previews with actor and target when observed. The isolated build, focused checks, and desktop/mobile fixture preview passed; the running installation has not activated this UI update. Live reaction meaning and topic checks remain release gates. [Reaction spec](SPECS.md), [live procedure](docs/release-acceptance.md) |
| Guarded projections and source ownership | Owner edits, audience checks, source-only archive browsing, derivative provenance, and three-store repositories have candidate evidence. Guarded acceptance (report removed for privacy), [storage plan](docs/original-only-archive-plan.md) |
| Provider and workflows | The shared CPA route and one-login refresh ownership were accepted locally. All nine Inngest workflow families were active at epoch 2 in the earlier consolidated installation. Provider cutover (report removed for privacy), workflow consolidation (report removed for privacy) |
| Owner UI and entity memory | Archive, Databases, Sharing, Activity, People/Projects, and the Memory map have isolated build, fixture, and preview evidence. The Relations knowledge-route allowlist matches the dashboard's owner storage paths, passes focused route tests, and is active: the owner view loaded its map, requests, and grants without route denial. Other live memory and release checks remain pending. Relations refresh (report removed for privacy), entity evidence (report removed for privacy) |
| Learned interpretation revision UI | Cards show kind, scope, uncertainty or owner status, and revision as badges, with actions aligned at the bottom of each row; the revised-entry filter remains. The detail panel presents current and original wording together, preserves revision history, and confirms saved corrections after the active revision refreshes. The updated dashboard build, TypeScript check, 24 dashboard tests, and AST graph refresh passed. An isolated synthetic preview serves on port 4179, but agent-side visual interaction verification remains pending because the in-app browser URL policy blocked localhost access. No operating app rollout was performed. [Requirement](SPECS.md) |
| Backup and recovery | Isolated format-6 backup/inactive restore, scoped reset, and fresh-acceptance validation passed synthetic rehearsals. The populated live post-reset run remains pending. [Storage plan](docs/original-only-archive-plan.md) |
| Local development | The `nocheh-dev` stack is stopped, and its retained volumes hold the copy that seeded the operating restore. Its source-mounted app builder previously passed TypeScript and Honcho Python reload checks without replacing containers or images. Telegram and provider logins were excluded from its state. The local operating `nocheh` stack now owns the normal ports. Browser visual verification of the dev revision was blocked by the in-app browser URL policy; production release acceptance is separate. Cleanup (report removed for privacy), data copy (report removed for privacy), restore (report removed for privacy) |
| Admin CLI inspection | The read-only `./bin/nocheh admin` provides event traces with linked reply IDs, event-filtered workflow receipts, Honcho, learned memory, reviews, and approvals using the authenticated loopback API. `trace latest` selects the newest captured incoming event, optionally by exact scope, and reports its ID and timestamp. Metadata is the default; source content requires `--content`. The operating app activated revision `508494b` and a metadata-only `trace latest` returned one linked reply and five workflows with a matching event filter. The database-backed workflow test skipped without an isolated PostgreSQL fixture; fresh owner live acceptance remains pending. The agent skill lives in `.agent/skills`. Activation (report removed for privacy), [CLI guide](docs/admin-cli.md), [agent skill](.agent/skills/nocheh-admin-cli/SKILL.md) |
| App deployment tooling | Exact-revision local and VPS plans and applies are implemented for existing Compose installations. Local apply checks the clean checkout and app ownership, rebuilds only `nocheh-app`, and waits for health. The operating local app was replaced with revision `508494b`; all 17 Nocheh containers were healthy after rollout. VPS apply requires a supplied SSH host and checkout path, verifies clean remote `main`, fetches and fast forwards to the selected revision, then runs local apply there. Focused tests and skill validation passed. VPS execution remains pending. The agent skill lives in `.agent/skills`. Activation (report removed for privacy), [Guide](docs/deploy.md), [agent skill](.agent/skills/nocheh-deploy/SKILL.md), [decision](docs/adr/0067-exact-revision-app-rollout.md) |

| Source layout | The owner command and admin CLI use `./bin/nocheh`; tooling is under `tools/`, the dashboard is under `dashboard/`, Hermes and Honcho are under `services/`, and the admin skill is `nocheh-admin-cli`. The two source increments were merged locally as `5ef25d0` and `e085adc`; pushing `origin/main` is blocked by unavailable HTTPS credentials. CLI, Python, TypeScript, dashboard, Compose, candidate image builds, and 371 isolated Hermes tests passed (3 skipped). On explicit owner direction, the operating Honcho provider gateway, API, and deriver were recreated with canonical source mounts using existing local images; all 17 Compose services were healthy. The ignored old source copy and legacy `integrations/`, `web/`, `scripts/`, and `admin/` directories were removed. The app and Hermes services were not recreated. [Decision](docs/adr/0069-role-based-source-layout.md), mount transition (report removed for privacy) |
| Repository cleanup | Thirteen redundant zero-byte Python subpackage markers were removed. The explicit `services` root remains to keep service imports unambiguous. The tracked tree and session worktree contain no other empty files or directories. An import/reference audit retained manual acceptance programs that produce documented evidence. The TypeScript build, 45 host Python tests, isolated package imports, and 371 Hermes tests passed (3 skipped). The operating installation was not redeployed. |
| Agent support layout | All three project skills, including Graphify, live under `.agent/skills`. The duplicate `.agents/` and `.codex/` paths, agent-specific hook, and `CLAUDE.md` link were removed. Root `AGENTS.md` keeps repository working instructions; Graphify usage remains there. [Decision](docs/adr/0070-single-agent-support-root.md) |
| Repository layout and privacy | Reusable acceptance code, overlays, fixtures, pins, and procedures have role-based homes; 215 tracked live result files and one private benchmark report were removed from the candidate tree, and output was redirected to ignored local state. The active documentation links now mark old reports as removed. The repository-wide tracked-path audit found code, configuration, documentation, and synthetic fixtures outside those reports. TypeScript build, 14 Compose configurations, CLI pin status, syntax and link checks, the AST graph refresh, and 21 isolated pinned-Hermes subscription tests passed. No live runtime rollout was performed. Re-run live gates whose only evidence was removed. Git-history purge, all-ref verification, and remote synchronization remain pending. [Layout](docs/repository-layout.md), [decision](docs/adr/0071-local-only-acceptance-evidence.md) |

## Development follow-ups

- **Deleted Telegram messages:** Ordinary Bot API deletions remain unobservable. The owner chose exact Archive retirement rather than an implicit second-message replacement; the original-only candidate implements that decision, while live activation and checks remain pending. The screenshot showed a first deleted voice note Waiting and a second Processing, but their final outcomes were not established. Verify a real owner retirement with saved event IDs after the layout transition, preserving the first captured source. [Telegram Bot API Update fields](https://core.telegram.org/bots/api#update).
- **Space-memory filters:** native-note/transcript filtering, its provider-payload/destination extension, and live native-review/filter quality and browser policy-save checks remain pending. [Boundaries](docs/space-memory-plan.md).
- **VPS:** app deployment tooling is ready for an existing remote checkout, but no host or checkout path is specified and no remote rollout has been run. Local Docker Compose remains the acceptance environment.
