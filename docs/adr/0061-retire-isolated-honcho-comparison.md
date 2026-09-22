# ADR-0061: Retire the isolated Honcho comparison

Accepted by the owner, 2026-09-22. Implementation and verification are in
[TASK.md](../../TASK.md).

<decision>

Honcho is the primary long-term memory under ADR-0033 and runs in the installation
Compose project under ADR-0045. Remove the optional synthetic
Hermes-versus-Honcho comparison, its separate Compose project, baseline runner,
fixture dataset, and experiment lifecycle command. Keep production Honcho's
metered provider gateway, read-only CLI, source pin, and protection tests with
the production integration.

The optional comparison's live result was never completed and is not an
activation or release gate. Production acceptance and attachment gates remain
separate and explicit. This supersedes ADR-0045 only where it retained the
historical experiment as an available facility; accepted historical decisions
remain in the ADR record.

The active installation's Honcho state directory, database name and user,
spending ledger, and external volume identities keep their existing names.
Those identifiers contain historical experiment wording but changing them
would require a separately verified data migration. Legacy project and volume
detection remains in place to prevent competing writers or silent empty-memory
replacement.

</decision>
