# ADR-0059: ELK calculates the Memory map layout

Status: accepted by the owner's implementation request. Date: 2026-09-22.

## Decision

Use the pinned `elkjs` layered algorithm to calculate positions for the React Flow
Memory map. The current visible nodes and semantic edges are the layout input.
Stable node and edge ordering, left-to-right layers, orthogonal edge routing,
crossing minimization, and explicit component spacing make the initial and reset
layouts predictable.

ELK positions are presentation state. The owner can drag nodes after layout, and
Reset layout or a changed visible graph calculates the arrangement again. Layout
runs asynchronously with a revision fence so an older result cannot replace a
newer filtered graph. A fixed-column fallback remains available if layout fails.

## Consequences

Connected records determine the diagram structure instead of node types occupying
fixed columns. React Flow continues to own rendering and interaction. ELK cannot
create, change, or authorize any relationship, project assignment, suggestion, or
access grant.
