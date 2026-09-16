<adr>

# ADR-0050: Platform-independent source identities and observations

<status>
Accepted for implementation by the owner's “start building” instruction following
the long-term import design review. Date: 2026-09-16. Implementation and acceptance
are tracked in [TASK.md](../../TASK.md); this decision does not activate a migration
on the local installation or add live Slack/Discord connectors.
</status>

<decision>
Keep the owned immutable event archive and PostgreSQL. Add a source model beside
the existing event, file, guarded-projection, consent, and workflow records.

- An object identity is `(platform, namespace, kind, external_id)`. External IDs
  are opaque strings; namespaces encode the source authority and any container
  within which an ID is unique. JSON tuples generate collision-safe internal IDs.
  Connector identity and local audience scope do not form the source identity.
- Source revisions group observations by an adapter-supplied revision label. A
  revision has no global sequence or inferred temporal ordering. A live event and
  an export can have different or partial payloads for the same object/revision;
  each remains an immutable observation with its own event key and provenance.
- Source relations are facts of an observation, referencing independently
  identified target objects. Placeholder identities permit out-of-order arrival.
  No target content, memberships, or permissions are copied into the referring
  observation. Resolution uses only authorized source events.
- A versioned descriptor carries adapter/version, operation, completeness,
  typed relations, metadata, and provenance. Operation and object/relation kinds
  are extensible labels; completeness distinguishes full, partial, and unknown
  observations. A deletion is an observation, not erasure of owned evidence.
- The common envelope accepts bounded platform labels with a descriptor for new
  platforms. Existing Telegram/browser/scheduler envelopes remain valid. New
  channels are archive-only until their execution adapters are implemented.
- Explicit descriptors are part of the event's immutable identity hash and
  portable envelope. Legacy events receive deterministic v1 projections without
  rewriting their keys, hashes, bytes, or originals. Bot API and Desktop source
  namespaces stay distinct until their identity mapping is established.
- Queryable JSON metadata complements indexed relational columns. Original payload/text,
  wire bytes, and uploaded export/file bytes retain their existing preservation
  paths. JSON normalization never serves as byte-preservation evidence.
- Database initialization runs a serialized, transactional, idempotent migration
  and bounded backfill. Backup verification includes all source-model tables.
  Future model changes use explicit migrations; unknown descriptor versions fail
  clearly rather than being interpreted as v1.
</decision>

<boundaries>
Nocheh audience policy remains independent of platform containers and memberships.
The owner can inspect source projections. Guarded event reads omit unprepared
descriptor metadata; graph APIs remain owner-only and relationship resolution
retains scope checks. Original source IDs and relation placeholders confer no
read capability.

This extends the archive from ADR-0018 and runtime ownership from ADR-0027 without
changing guarded-original separation from ADR-0033 or space policy from ADR-0030.
It does not revive the superseded guarded-only log design in ADR-0013.

No automatic Slack/Discord parsing, source ACL synchronization, connector polling,
identity guessing, canonical latest-state projection, or deployment is included.
These adapters can use the common source contract and existing resumable imports.
</boundaries>

<verification>
The [source-model guide](../source-model.md) defines the contract and fixture
acceptance. Verify real PostgreSQL migration/restart, concurrent imports,
namespace collisions, partial/deletion observations, out-of-order relationships,
scope denial, original/file/provenance round trips, and inactive backup recovery.
</verification>

</adr>
