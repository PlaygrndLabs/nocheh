<adr>

# ADR-0090: Bounded agent organization with deferred application and owner supervision

<status>
Accepted by the owner's request to implement agent-led knowledge management.
Extends [0041](0041-local-inngest-workflows.md),
[0053](0053-original-only-archive.md),
[0057](0057-memory-relationship-access-map.md), and
[0083](0083-defer-automatic-memory-publication-during-replies.md).
Supersedes only [0056](0056-connected-entity-memory.md)'s requirement for individual
owner confirmation of every discovered project: evidence-backed project creation
may instead use explicit bounded owner delegation. Ambiguous project identities,
person links, and cross-platform identity matches still require exact review.
Implementation, activation, and acceptance evidence belong in
[TASK.md](../../TASK.md).
</status>

<context>
Nocheh is a personal AI brain built around owned sources, useful memory, and
reasoning. Requiring the owner to perform every organization step makes projects
an administrative burden. Giving a runtime broad administrative credentials
would couple the product to that runtime and confuse organization with authority
to reveal knowledge or take external actions.

The accepted approach lets the agent inspect, prepare, and manage changes while
the owner chooses its scope and supervises exceptions. Projects remain optional
aids to understanding; this decision introduces no company hierarchy or new
entity taxonomy.
</context>

<decision>

<area name="Authority and evidence">

Nocheh owns typed knowledge inspection, proposal, and status contracts. The
runtime produces proposed changes, never authorization. Owner-private turns may
prepare exact project changes, entity corrections and links, sharing rules, and
fact-access changes using existing validators. Runtime tools receive neither an
admin credential nor an unrestricted owner-API proxy.

The owner can delegate only project creation and conversation assignment. Each
permission names exact conversations, permitted existing projects, whether new
projects may be created, and optional expiration. It starts disabled and defaults
to lasting until revoked. Evidence that a project exists is separate from
evidence that a conversation belongs to it; a mention cannot reassign a chat.

Delegation records capture-sequence watermarks and conversation assignment
baselines. Live evidence after the watermark can support automatic organization;
imports, historical reprocessing, and backfill cannot acquire that authority.
Owner-private requests may explicitly propose changes using authorized historical
evidence. An owner assignment edit suspends automatic changes for that scope.
Only explicit resumption updates its baseline; an unrelated permission edit does
not resume it.

Group assignments account for inheriting topics. An unselected affected topic
requires review. Exact review freezes and displays the affected topic set; a new
inheriting topic makes the prepared effect stale. Project organization grants no
participant permission, source access, fact access, or external-action authority.
Filtered sharing and exact fact grants retain their separate owner controls.

</area>

<area name="Durability and deferred application">

The existing consented live-learning result may contain structured organization
proposals without a separate model request for every message. Proposals persist
before application. Generated proposal contents live in derived storage; authority,
delegation history, application decisions, and receipts live in control storage.
Original evidence remains in the archive.

The `organization` Inngest family applies persisted changes. Owner-turn proposals
wait for confirmed turn completion. Learning proposals are enqueued only after
learning completes, including recovery of a completed learning operation. The
foreground publication check defers automatic application during active replies;
owner and privacy revocations keep their immediate enforcement path.

Related project creation and assignments share one control transaction, one
application receipt, and at most one memory invalidation. Shared transaction-level
project operations avoid several independently invalidating owner commands.
No-op assignments produce no repeated rebuild. Deduplication binds original
evidence and intended changes rather than transient learning-job or epoch IDs.

Before applying, trusted code rechecks delegation revision, installation
generation, guarded proposal and source dependencies, consent, retirement, project
state, assignment baselines, and inherited effects. A different epoch caused by
completed unrelated learning is acceptable only after the relevant dependencies
validate against the current binding. Retry and restart reconcile the same
operation. Waiting, review required, stale or conflicting, cancelled, failed,
applied, and undone outcomes retain distinct evidence. Revision-checked undo
preserves original receipts and cannot overwrite later owner changes.

</area>

<area name="Owner supervision and portability">

Activity opens a common Decisions inbox over action approvals, memory-access
requests, identity suggestions, and knowledge proposals. Server pagination,
totals, and exact-item reads cover the complete stored set. Successful automatic
work remains in history. Review reuses the existing exact validators rather than
substituting a generic permission button.

The stored conversation directory supplies named selectors in Projects and
Sharing without querying Telegram. Conversation context separately presents who
may address Nocheh, what knowledge it may use, and what actions it may perform.
Project context combines knowledge, effective assignments, and relevant decisions.
Overview distinguishes pending decisions and memory availability from service
connection and synchronization. Existing routes, deep links, drafts on failed
saves, and unavailable-observation states remain part of the contract.

Portable export and coordinated backup include proposals, delegations and their
history, decisions, and application and undo receipts. Portable import preserves
authority as inactive history; import and inactive control-record restore cannot
activate permissions or queued organization work. Adding the schemas and workflow
family grants no automatic delegation to an existing installation.

</area>

</decision>

<consequences>
The agent can reduce recurring owner work without expanding authority from
relationships, confidence, or untrusted source text. The owner can inspect the
specific evidence and effect of each change and correct or stop it. Exact
conversation scopes and revision checks can send a useful suggestion to review
after new topics or owner edits; this is an explicit limit on delegated authority.

This decision does not establish memory-recall quality, production Honcho
readiness, deployment, or release. Those gates retain their independent evidence.
</consequences>

</adr>
