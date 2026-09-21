# ADR-0058: Memory map editing uses semantic owner commands

Status: accepted by the owner's implementation request. Date: 2026-09-22.

## Decision

Render the owner-only Memory map with React Flow. Nodes can be selected, dragged,
and arranged; the canvas supports pan, zoom, fit controls, a minimap, and a
deterministic reset. Node positions are presentation state and do not change
memory, relationships, projects, or access.

Selecting a node or edge opens the editor for its underlying record. Every save
uses the existing owner-only, idempotent, revision-checked command boundary.
Person names use an entity rename command; projects and assignments use project
commands; fact and relationship corrections create a new claim revision;
suggestions use their decision command; and access edges use grant or revocation
commands.

The only graph connections the canvas can prepare are a fact to a concrete group
or topic, which opens a persistent grant review, and a project to a group or topic,
which opens an assignment review. Drawing a connection never persists it. Arbitrary
relationship creation remains unavailable because relationships require evidence.

## Consequences

The graph is an interactive projection over authoritative records rather than a
second data model. Diagram manipulation cannot bypass evidence, audience, revision,
guard, or approval checks. The complete list remains available when a graph is not
usable, and the existing Evidence graph remains separate.
