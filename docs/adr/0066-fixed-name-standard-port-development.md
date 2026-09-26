# ADR-0066: Development uses the normal stack and ports

Accepted by the owner, 2026-09-27. Implementation evidence is in
[TASK.md](../../TASK.md).

<decision>

`make dev` runs the standard services, including Honcho, in one Compose project
named `nocheh-dev` on the normal localhost ports. It refuses to start while
another Nocheh stack runs. The stopped operating installation retains its state.

The existing `nocheh-app` container watches source and builds generated assets
into shared volumes. Running Node and Python services reload on ordinary source
edits. There is no separate builder service and no image rebuild or `make dev`
rerun for those edits. Dependencies and Dockerfiles still require an image build.

Dev credentials, PostgreSQL volumes, and Honcho storage are separate from the
operating installation. Telegram remains disabled. External provider calls need
their own development credentials. A fixed Compose name permits one development
checkout at a time; startup checks the checkout ownership of its containers and
volumes.

This supersedes [ADR-0065](0065-single-stack-source-mounted-development.md) on
the builder service, Compose name, ports, and Honcho service inclusion.

</decision>
