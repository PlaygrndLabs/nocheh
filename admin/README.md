# Nocheh admin CLI

`nocheh-admin` is a read-only inspector for the local installation. It uses the
same authenticated loopback API as `./scripts/nocheh`, so it needs that
installation's own configuration and a running app service. Run it from the
installation checkout, or set `NOCHEH_STATE_DIR` to that installation's state
directory. It never starts services or changes attachment, approval, or memory
state.

```sh
./admin/bin/nocheh-admin status
./admin/bin/nocheh-admin events --kind incoming
./admin/bin/nocheh-admin events --reply failed --json
./admin/bin/nocheh-admin trace EVENT_ID --json
./admin/bin/nocheh-admin workflows --event EVENT_ID --json
./admin/bin/nocheh-admin workflow WORKFLOW_ID --json
./admin/bin/nocheh-admin honcho --json
./admin/bin/nocheh-admin learned --json
./admin/bin/nocheh-admin reviews --json
./admin/bin/nocheh-admin approvals --json
```

The same commands are available as `./scripts/nocheh admin ...`. `--json` and
`--content` can appear before or after a command. By default, source text,
payloads, chat identifiers, and reply text are redacted while IDs, states,
timestamps, and receipt links remain visible. `--content` opts into sensitive
source content on the terminal; keep its output out of commits and logs.

`events` returns at most 50 records with a `next` cursor; pass that cursor as
`--after` to continue. `workflows` returns at most 100 and supports `--event`
for one captured source. `trace` combines a direct event lookup, linked
confirmed reply previews, and workflows for that event. A linked reply is
observed evidence; the CLI does not mark a live gate as passed or decide an
ambiguous send. `workflow-health`, `honcho`, `learning`, `search`, and `event`
provide focused inspection. Run `--help` for all options.

The CLI cannot fabricate owner or group Telegram traffic. Live acceptance
still requires fresh owner input and saved event IDs and timestamps as described
in [the release procedure](../docs/release-acceptance.md).
