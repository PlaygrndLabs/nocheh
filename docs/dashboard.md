# Owner dashboard and CLI

Start the archive with `./scripts/nocheh up`. With Node 22+ and Python 3 available
locally, install the repository's locked development dependencies using `npm ci`,
then run:

```sh
./scripts/nocheh dashboard
./scripts/nocheh dashboard --no-open
./scripts/nocheh dashboard --stop
```

The dashboard is at <http://127.0.0.1:8783/nocheh>. Its native Hermes shell runs in
a separate Compose project, with a private presentation-only home and loopback
backend port 8784. The TypeScript owner API runs locally; it does not expose a
Docker socket to containers. The launcher builds the pinned native dashboard
assets using the upstream npm lockfile. Stop and start to rebuild after updates.

Settings show saved `.env` values with credential presence only. Review and Save
validates the complete configuration. Apply is a background job that recreates
affected Compose services and checks health; failed apply attempts restore the
previous environment and report whether recovery succeeded. Runtime state is
shown as unverified until the management apply operation verifies it.

Imports accept Telegram Desktop JSON, an export directory or ZIP. Review counts,
missing media and chat scopes before starting. Unmapped chats remain owner-only.
Explicit group mapping shares history with that group. The original export JSON
is preserved as an archive artifact with a batch manifest. Media and message
payloads reuse the existing archive importer unchanged. Imports send no old
replies and do not automatically run memory derivation.

Jobs retain progress under the private `data/local/admin/jobs/` directory. Stop
or interrupted jobs can resume; already committed sources remain preserved.
Upload limits are 32 MiB export JSON, 50 MiB per media file, 256 MiB uploaded ZIP,
512 MiB total unpacked/uploaded content and 10,000 files. The old import commands
remain supported alongside these conveniences:

```sh
./scripts/nocheh config show
./scripts/nocheh config set NOCHEH_GUARD_MODE auto
./scripts/nocheh config apply
./scripts/nocheh import telegram /absolute/export/result.json
./scripts/nocheh jobs list
./scripts/nocheh jobs show JOB_ID
```

Secret settings take a hidden prompt or piped stdin, never a value in argv.
The dashboard owner session is separate from the archive service credential and
Hermes OAuth. No remote login is implemented; ports bind only to localhost.
The native shell's agent, gateway, filesystem, credential and configuration-write
routes are blocked. Use the Nocheh pages for management.

## Native memory and Honcho

Memory selects only the configured owner/group profiles. Notes are read-only;
preferences use the same locked resolver as assistant startup and take effect on
the next turn. Session messages are paginated in groups of 50, with a 20,000
character preview per message. Notes are bounded to 256 KiB and explicitly show
truncation. A note's presence does not establish source provenance.

```sh
./scripts/nocheh memory list
./scripts/nocheh memory show --scope CHAT_ID
./scripts/nocheh memory show --scope CHAT_ID --session SESSION_ID --offset 50
./scripts/nocheh memory preferences --scope CHAT_ID
./scripts/nocheh honcho doctor
./scripts/nocheh honcho install
./scripts/nocheh honcho workspace list
./scripts/nocheh honcho peer inspect PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho peer representation PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho conclusion list --observer PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --page 2 --size 50
./scripts/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --all > transcript.json
```

Honcho lifecycle (`init`, `up`, `down`, `status`, `login`) delegates to the existing
experiment. Initialize it before `honcho install`. Inspection uses official
`honcho-cli==0.1.4` / `honcho-ai==2.4.0`, pinned dependencies and an internal-only
Compose runner with a fresh CLI config directory. Ambient Honcho accounts are
ignored. A narrow transport changes SDK get-or-create lookups into exact-ID list
queries and rejects writes, model-backed search/chat and unexpected endpoints.
Missing resources remain missing. Stored representation retrieval has no search
query; it does not request embeddings. Native list commands walk pages; the
wrapper caps at 100 pages and reports failure rather than silently exporting an
incomplete collection. `complete` refers to the requested command/limit, with
server pagination metadata retained. Inspect is a summary, not a full export.

The dashboard shows experiment availability and workspace/peer/session lists.
The CLI provides deeper stored-data inspection. Live compatibility with the pinned
Honcho server remains pending the separate bridge login and temporary embedding
credential; fixture tests do not certify that live comparison. No experiment
inference or production-memory switch is performed by the dashboard.
