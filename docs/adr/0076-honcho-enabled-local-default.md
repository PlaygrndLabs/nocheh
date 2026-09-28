# ADR 0076: Enable Honcho in fresh local installations

Status: Accepted

Extends ADR-0033's primary-memory choice and ADR-0045's installation Compose
placement. It changes the fresh-installation service default, not the live
acceptance or owner attachment gates.

## Decision

Fresh local configuration enables Honcho and prepares its protected runtime
credentials by default. The normal `up` command verifies the pinned upstream
source before building and starting the Honcho profile. An installation can
explicitly disable the profile in its saved configuration.

Service startup does not attach Honcho memory. The production live acceptance
and owner attachment gate remain separate. Initial attachment excludes earlier
history unless the owner selects it. Existing explicit installation settings
and spending ledgers are preserved.

## Rationale

Honcho is Nocheh's primary long-term memory. Preparing its service in the
standard setup avoids a second installation path while retaining the guarded
provider, spending, provenance, and acceptance boundaries.
