# ADR-0057: Memory relationships do not confer audience access

Status: accepted by the owner's implementation request. Date: 2026-09-21.

## Decision

Add an owner-only two-dimensional Memory map over human people and projects,
conversations, topics, versioned facts, descriptive relationships, project
assignments, explicit access grants, and pending suggestions. Keep the existing
source Evidence graph unchanged. Honcho peer/workspace mappings remain technical
details of their human entity rather than first-class presentation nodes.

Relationship discovery and access authority remain separate. Relationships may
identify a high-relevance fact for private owner review, but never grant access,
broaden a group query, or reveal an inaccessible entity, relationship, path, count,
or fact. Projects remain organizational. Every grant names one concrete group or
topic and one exact guarded fact representation.

Group turns first answer from their existing authorized context. A separate trusted
review path may inspect owner-authorized facts reached through bounded confirmed or
evidence-backed relationships and create a private request afterward. The dashboard
contains exact content and provenance; Telegram receives only a content-free owner
notification with a link to that authenticated dashboard. Rejection closes only
the current request.

Owner approval creates either a request-bound one-time grant or a persistent grant.
One-time access is consumed only by confirmed delivery. Persistent access lasts
until revoked or suspended. Changes to the fact revision, evidence, guard binding,
or authorization generation suspend access before reuse. Previously delivered
messages cannot be retracted.

## Defaults and controls

New groups and topics have only their own audience memory. Related-fact suggestions
are enabled at a high-relevance threshold, deduplicated per source request and fact
revision, and expire after 24 hours. Approval defaults to one-time and resumes the
pending response automatically. Notification, follow-up, lifetime, suggestion
enablement, and default grant mode have installation defaults with destination
overrides.

Owner-private recall continues to span all authorized memory and creates no access
request. An owner-authored message inside a group remains group-scoped.

## Consequences

Fact grants and their decisions, revisions, receipts, settings, and derived
representations become durable portable state. Private review and follow-up reuse
the existing guarded-representation and receipted Telegram-effect boundaries.
Production Honcho activation, provider cutover, and release acceptance remain
separate gates.
