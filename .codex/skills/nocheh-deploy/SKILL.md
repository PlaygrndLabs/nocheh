---
name: nocheh-deploy
description: Plan or apply an exact-revision Nocheh app rollout to an existing local Docker Compose installation or VPS checkout.
---

# Nocheh app deployment

Read [the deployment guide](../../../docs/deploy.md), [current status](../../../TASK.md),
and the applicable [release gates](../../../docs/release-acceptance.md) before
deploying. Use `./scripts/nocheh deploy local` for the operating local checkout,
or `./scripts/nocheh deploy vps --host HOST --root /absolute/checkout` for an
existing remote checkout. Supply the full integrated commit ID with `--revision`.
Run without `--apply` to see the target and revision, then run with `--apply`
when deployment is authorized.

The local command requires a clean checkout, its own `.env`, and one app
container owned by that checkout. It rebuilds and recreates only `nocheh-app`
and waits for health. The VPS command uses noninteractive SSH, fetches `main`,
fast forwards its clean remote checkout to the exact revision, then runs the
same local command there. Never copy credentials, runtime data, or OAuth state
between installations. Never infer a VPS host, checkout path, or authorization
from the local installation.

After the rollout, inspect service health and the relevant read-only admin API
from the target installation. Record the revision, target, command outcome, and
fresh evidence in `TASK.md`. A healthy service is deployment evidence, not a
release or live acceptance pass. Stop on a failed ownership, revision, Git,
health, or API check; diagnose before another apply.
