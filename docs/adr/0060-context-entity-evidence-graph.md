<adr>

# ADR-0060: Context-entity evidence graph

<status>
Accepted by the owner in the graph-node filtering request. This decision narrows
the graph data contract; implementation and activation evidence remain in
[TASK.md](../../TASK.md).
</status>

<decision>
The owner-facing 3D graph and its JSON export contain only durable context
entities: users, projects, groups, and messages. Operational actions and events,
runtime-context artifacts, attachments, generated derivatives, native runtime
profiles, and memory-note records are excluded before layout.

Observed authorship, message replies and revisions remain recorded relationships.
An explicit project assignment may connect a project to its group, but neither the
assignment nor graph reachability grants access. Original records and generated
artifacts remain inspectable in their authoritative Archive, Memory, Activity, or
source-detail surfaces without becoming graph nodes.

Filtering is part of the API and export contract, with an adapter and browser
allowlist as rollout defenses. This supersedes only the broad evidence-node
taxonomy and unchanged-export clause in ADR-0026. It preserves ADR-0026's local
3D interaction and accessibility decisions and ADR-0056's separation between
descriptive relationships and access authority.
</decision>

<consequences>
Node count reflects navigable context rather than processing volume. Adding a new
graph node category requires an explicit product-specification change instead of
automatically exposing a new event or artifact kind. Source retention is
unaffected because filtering changes a projection, not the owned records.
</consequences>

</adr>
