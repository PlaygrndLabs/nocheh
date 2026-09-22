# ADR-0062: Owner-managed Telegram group participants

Accepted by the owner, 2026-09-23. Implementation and activation evidence are in
[TASK.md](../../TASK.md).

<decision>

Selection of a Telegram group permits the owner to address Nocheh there. It does
not automatically permit every group member to start an assistant turn. A group
participant needs an explicit owner grant for that group; an explicit deny wins,
and revocation returns the participant to the owner-only default. These decisions
control replies and tool-using turns, separately from source capture and memory
sharing.

Store decisions with the installation's single editable configuration source
under `TELEGRAM_GROUP_ACCESS`. The dashboard offers structured per-group controls
and the CLI offers list, grant, deny, and revoke. Settings are validated against
selected groups and the owner ID before being applied. The owner cannot be
granted or denied through participant rules. No group message can administer this
configuration.

Enforce the same policy in Hermes's Telegram scope resolver and Nocheh's dispatch
admission. The final delivery check reads the captured original sender against
the current policy, so a queued or running turn cannot deliver after access is
revoked. A configuration change also advances runtime authority before new turns
are admitted. Unknown or malformed group decisions fail closed.

This extends [ADR-0021](0021-scoped-native-assistant-processes.md) on selected
group scope and [ADR-0024](0024-single-environment-configuration.md) on the
single editable settings source. It does not change the separate memory access
model in [ADR-0030](0030-configurable-space-memory.md) or
[ADR-0057](0057-memory-relationship-access-map.md).

</decision>
