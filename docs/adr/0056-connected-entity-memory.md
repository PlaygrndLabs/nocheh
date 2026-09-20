<adr>

# ADR-0056: Connected Honcho memory for people and projects

<status>
Accepted by the owner in the connected-memory implementation request. Activation remains subject to the existing Honcho acceptance gates recorded in [TASK.md](../../TASK.md).
</status>

<decision>
Nocheh maps each canonical person and confirmed project to a stable Honcho peer in each audience workspace. Mapping records carry a representation version and workspace generation. The first connected-memory write retires the corresponding generic `source` generation without deleting its receipts or provider data.

Original messages are authored by the actual speaker in a persistent conversation session. A project or mentioned person receives a separate typed entity-evidence observation with the original speaker, source, subject, and attribution. These observations cannot represent the subject as the speaker. Nocheh keeps canonical identities and owner review decisions in control storage, versioned claims and relationships in derived storage, and evidence in the archive.

Recall begins with a permitted entity and follows evidence-backed relationships using bounded breadth-first traversal, cycle detection, deduplication, and explicit paths. Each candidate entity and every relationship evidence set must pass the caller's audience check before its name or memory can be returned. Project membership and graph reachability do not authorize access.
</decision>

<consequences>
Exact platform identities are automatic. Ambiguous aliases, cross-platform links, and discovered projects require owner confirmation. Linking and unlinking identities uses revision-checked owner commands, advances the guard epoch, and rebuilds memory before reuse. The owner dashboard and `/v1/entities` expose current memory, evidence, uncertainty, suggestions, corrections, and link history. The inferred entity graph remains separate from the archive's observed-source graph.
</consequences>

</adr>
