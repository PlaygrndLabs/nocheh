# Nocheh admin CLI

`./bin/nocheh admin` is a read-only inspector for the local installation. It uses the
same authenticated loopback API as `./bin/nocheh`, so it needs that
installation's own configuration and a running app service. Run it from the
installation checkout, or set `NOCHEH_STATE_DIR` to that installation's state
directory. It never starts services or changes attachment, approval, or memory
state.

```sh
./bin/nocheh admin status
./bin/nocheh admin events --kind incoming
./bin/nocheh admin events --reply failed --json
./bin/nocheh admin trace EVENT_ID --json
./bin/nocheh admin trace latest --json
./bin/nocheh admin trace latest --scope CONVERSATION_SCOPE --json
./bin/nocheh admin timings EVENT_ID --json
./bin/nocheh admin workflows --event EVENT_ID --json
./bin/nocheh admin workflow WORKFLOW_ID --json
./bin/nocheh admin honcho --json
./bin/nocheh admin learned --json
./bin/nocheh admin reviews --json
./bin/nocheh admin approvals --json
```

Use `./bin/nocheh admin ...` for all inspection commands. `--json` and
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

`trace latest` selects the newest captured incoming event, then returns its
event ID and timestamp with linked output. Use `--scope` when other
conversations may be active, and confirm the selected event before using it as
acceptance evidence.

The direct `event` and `trace` commands and the `workflows --event` filter
require the matching app API revision. They fail explicitly when the running
installation has not activated that revision, rather than returning an
unfiltered workflow page or omitting linked replies.

The CLI cannot fabricate owner or group Telegram traffic. Live acceptance
still requires fresh owner input and saved event IDs and timestamps as described
in [the release procedure](../docs/release-acceptance.md).

<timing_boundaries>

`timings EVENT_ID` joins the event's workflow listing with its security effect
page. Use `workflow WORKFLOW_ID` for the workflow's individual receipts. `effects.next` is the cursor for `--after`; a missing measurement is `null`,
not zero. Earlier receipts are not retroactively measured. The CLI rejects an API
without the exact event filter. The numeric measurements contain no source text,
prompts, credentials, URLs, or exception bodies.

- `broker_prepare_ms`: credential-route lookup, guarded preparation, and final
  permission checks before the provider request.
- `provider_headers_ms`: waiting for the provider transport to return response
  headers, including the local subscription proxy, network, and remote service.
- `provider_read_ms`: time awaiting upstream stream reads, excluding the broker's
  per-chunk permission checks and downstream backpressure. Buffered bytes may
  return immediately; this is observed waiting, not isolated model computation.
- `downstream_ms`: per-chunk permission checks and forwarding/backpressure.
- `provider_chunks`: observed chunks, not model tokens.

The upstream headers and read waits can be added for observed provider-transport
waiting. Native `conversation`, `context_prepare`, and `model_guard` phases can
overlap; do not add them or add the broker measurements to those inclusive phases.
Native phase timings are retained in runtime receipts and are not included in
the CLI workflow listing. `model_guard` includes detector calls and their waiting;
a selected chat model transport measurement is not the total time spent on all
model requests.
Workflow admission/completion timestamps include orchestration waits and retries.
Failure receipts retain measurements made before failure; absent phases remain
unavailable. Completion and latency are evaluated separately.

</timing_boundaries>
