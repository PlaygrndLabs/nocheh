# ADR-0067: Exact revision app rollout for existing Compose installations

Accepted by the owner, 2026-09-27. Implementation and activation evidence is in
[TASK.md](../../TASK.md).

<decision>

The app service has one deployment command for an existing local installation
and one for an existing VPS checkout. Both use the same Compose configuration
and require an exact integrated Git revision. A plan is read-only; an explicit
apply rebuilds and recreates only `nocheh-app` and waits for health.

The local command checks that the checkout is clean and owns the running app.
The VPS command uses a supplied SSH host and absolute checkout path, fetches
`main`, fast forwards a clean checkout to the selected revision, then invokes
the local command on the VPS. Credentials and runtime state stay with each
installation. Deployment, live acceptance, and release remain distinct gates.

This extends [ADR-0019](0019-local-compose-development-and-acceptance.md) with
remote app rollout tooling; local Compose remains the acceptance environment.

</decision>
