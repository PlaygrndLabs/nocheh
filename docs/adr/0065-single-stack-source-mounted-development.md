# ADR-0065: One running stack with source-mounted development

Accepted by the owner, 2026-09-27. Implementation and verification evidence are
in [TASK.md](../../TASK.md).

<decision>

Local development runs one Nocheh Compose project at a time. `make dev` refuses
to start when another Nocheh project has running core services. An operating
installation must be stopped before starting a checkout's development project;
its containers, volumes, credentials, and data remain intact.

The development project mounts checkout source into one builder container and
Python runtime containers. The builder automatically compiles TypeScript,
React, CSS, and dashboard assets into project-scoped volumes. Node watches the
generated code, the browser dashboard reloads on asset revision changes, and
Python supervisors restart their child processes on mounted source changes.
Ordinary source edits require no Docker image rebuild or command rerun.
Dependency, image, and Dockerfile changes require a new image build.

Development retains its own state, generated credentials, ports, and verified
pinned provider and Hermes image bases. Telegram and installation logins stay
outside the development project. Optional external model and Honcho activity
requires separate development credentials. This workflow does not establish
release acceptance.

This supersedes [ADR-0064](0064-isolated-source-watched-development-preview.md)
on concurrent projects and rebuild-on-edit behavior. Its checkout isolation and
credential boundaries remain in effect.

</decision>
