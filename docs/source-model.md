<source_model>

# Import source model

<contract>
The source model extends the [archive](archive.md) and [portable import](import-export.md)
contracts. [ADR-0050](adr/0050-platform-independent-sources.md) records the design.

New platforms submit a version-1 event envelope through the owner-only
`/v1/import` endpoint with `channel` set to the platform and `source` set to a
versioned descriptor. `source.object.platform` matches `channel`, and
`source.object.external_id` matches `source_id`. `revision` is an opaque source
revision label, not an insertion sequence. Example descriptor:

```json
{
  "version": 1,
  "adapter": "slack.export",
  "adapter_version": "1",
  "object": {
    "platform": "slack",
    "namespace": "[\"workspace:T1\",\"conversation:C1\"]",
    "kind": "message",
    "external_id": "1700000000.000001"
  },
  "operation": "snapshot",
  "completeness": "full",
  "relations": [],
  "metadata": {"format_version": 1},
  "provenance": {"import_job_id": "example-job"}
}
```

The example describes the contract; it does not indicate an implemented Slack
export parser. Custom platforms and non-message kinds use the same contract.
Namespaces must include every source boundary needed for uniqueness. An adapter
must establish export/live identity equivalence before reusing a namespace.
Connecting another bot or mapping an import to a local audience does not change
an established external source identity. An event key still uniquely identifies
one observation; identical retries reuse that key and changed content conflicts.

Relations contain a `kind`, a complete target object identity, and optional
`metadata`. Common kinds are `authored_by`, `contained_in`, `in_thread`,
`reply_to`, and `derived_from`; other bounded labels are accepted. Attachments
continue to use the existing event-linked artifact/file store and checksums.
Unknown targets create identity placeholders; they never become readable source
content until authorized observations exist.

`completeness` is `full`, `partial`, or `unknown`. The adapter chooses an operation
such as `snapshot`, `update`, `delete`, or `reaction`. Missing fields in a partial
observation do not clear prior values; the archive records observations and does
not infer a latest merged state. Timestamps and revision labels remain original
strings, and arrival order does not establish source chronology.

Labels use lowercase ASCII letters, digits, dots, underscores, and hyphens, start
with a letter, and contain at most 64 characters. Identity components and adapter
versions are nonempty strings of at most 768 UTF-8 bytes without control characters.
Descriptors contain at most 100 distinct kind/target relations and 256 KiB in
canonical JSON. Metadata/provenance objects are at most 64 KiB each, with at most
20 nesting levels, and obey
PostgreSQL JSON constraints; arbitrary original payload and file bytes retain
their separate preservation path. Unknown descriptor fields/versions are rejected;
platform extensions belong in metadata or original payloads.
</contract>

<storage>

| Table | Purpose |
| --- | --- |
| `events` | Immutable original observation; optional explicit descriptor bytes |
| `source_objects` | Unique platform/namespace/kind/external ID, including unresolved targets |
| `source_revisions` | Object plus opaque revision label |
| `source_observations` | Event-to-revision binding, model and adapter versions, operation, completeness, metadata, provenance |
| `source_relations` | Typed observation-to-object relationships |
| `source_model_migrations` | Completed source-model migrations |

Objects and revisions can have several observations with different payloads and
audiences. Payloads remain attached to events, so grouping identities cannot merge
private evidence into a public read. Foreign keys maintain referential integrity;
audience checks still control source reads, search, files, and graph resolution.

Telegram Bot API and Desktop parsing is confined to the legacy v1 source adapter.
Desktop identifiers stay in their own namespace even when mapped to an existing
Telegram audience. Browser and scheduler sources also receive typed identities.
Unrecognized legacy event kinds use conservative event-level identities.

Owner event reads and portable exports include `source_model` for inspection.
Explicit `event.source` round-trips as original data. Generated legacy projections
are rebuilt from original envelopes by the frozen v1 adapter on reimport; the
exported inspection view cannot override that adapter. Guarded reads omit source
descriptors because their metadata has no prepared guarded representation.
</storage>

<acceptance>
Use `compatibility/source-model-compose.yml` as a standalone Compose project with
explicit `NOCHEH_SOURCE_FIXTURE_PROJECT`, `NOCHEH_SOURCE_FIXTURE_IMAGE`, and a
synthetic `NOCHEH_SOURCE_FIXTURE_PASSWORD`. It has a private internal network,
project-owned PostgreSQL volume, no published ports, and no runtime, poller,
scheduler, OAuth owner, or production configuration mounts. Build its development
image from the pinned root Dockerfile or a verified cached development image with
the same package lock and Node 24.

Run `dist/test/source-model.test.js` for focused acceptance and the existing
TypeScript/PostgreSQL suite for regressions. Its database-disconnection check
requires explicit `NOCHEH_WORKFLOW_FIXTURE=1`; enable that flag only for its
isolated run. Real Inngest/bootstrap and Docker-routing checks require their own
documented fixtures and are not provided by this PostgreSQL-only project.
Repeat initialization and migration
against pre-model events, verify preservation and conflict rejection, exercise
Slack-shaped/Discord-shaped/non-message fixtures, and verify portable originals,
missing/supplied files, scope isolation, and silent replay. Run the existing Python
archive/import-job/operations tests. Verify a fixture-only PostgreSQL dump/restore
and restart with identical source-model fingerprints before marking recovery as
passed. Runtime activation requires a separately authorized installation migration.
</acceptance>

</source_model>
