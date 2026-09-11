# Shared subscription provider and monitoring

CLIProxyAPI is the single ChatGPT subscription login for Hermes reasoning,
Honcho reasoning and subscription speech. CLIProxyAPI alone owns and refreshes
the OAuth files. Hermes and Honcho receive different local API keys. Speech runs
behind an isolated gateway that can read only the current access token from the
OAuth directory; it cannot write the directory or expose the refresh token.

The local stack pins CLIProxyAPI at
`c76dfd4e0edabab9000628b1560ab8ab379eadb8` and CPA Manager Plus Full Mode at
`1ae656c82990c480f3f104326a08c6e0001eeb4c`. CPA Manager Plus stores request,
usage, latency, failure and account observations in
`data/local/provider/monitor/`. Its automatic account actions, quota actions,
notifications and request-body logging are disabled. A monitoring outage does
not stop inference.

## First login and cutover

Start the pinned services, complete one fresh device login, then run the atomic
cutover:

```sh
./scripts/nocheh up
./scripts/nocheh provider status
./scripts/nocheh provider login
./scripts/nocheh provider cutover
```

`provider login` refuses to start when any provider login file already exists.
`provider cutover` also requires exactly one active Codex credential. It switches
the saved reasoning route to `shared`, recreates the affected services, and uses
synthetic inputs to verify:

- CLIProxyAPI is the refresh owner and Hermes does not refresh the token;
- Hermes chat, literal detection and Ogg/Opus transcription;
- the Honcho client key can make a reasoning request through the same login;
- CPA Manager Plus observes requests;
- reasoning continues while monitoring is stopped; and
- reasoning and transcription recover after all provider components restart.

Any failed check restores the previously saved route and leaves the native login
in place. After every check passes, the old Hermes OAuth file moves out of the
runtime to `data/local/provider/retired/`; it is retained privately for inspection
or a deliberate rollback and is no longer a refresh owner. The content-free local
report is `data/local/reports/shared-provider-acceptance.json`.

Infrastructure health alone does not prove subscription access:

```sh
./scripts/nocheh provider verify
./scripts/nocheh provider status
```

`verify` checks the pinned source revisions and both service health checks.
`status` reports counts and health without returning credentials. A fresh login is
still pending when `login_present` is false.

## Owner monitoring UI

Run `./scripts/nocheh dashboard` and choose **Provider monitor** from the sidebar
or **Integrations**. Nocheh serves CPA Manager Plus at
`/providers/management.html` through the existing owner session. The browser
never receives the CLIProxyAPI management key or the CPA Manager Plus admin/data
keys. Nocheh adds the monitor credential server-side and requires its own CSRF
token for writes. The direct monitor port is loopback-only.

Provider OAuth and monitor history are included in backups while their writers
are stopped. Restores quarantine both native and shared OAuth credentials before
starting the new Compose project, so a restored copy cannot become a second
refresh owner. Re-authenticate deliberately after restore reconciliation.

Honcho's reasoning now uses this shared login. Honcho memory activation remains a
separate gate because embeddings use the dedicated capped paid route; a successful
subscription cutover does not make a failed embedding check pass.
