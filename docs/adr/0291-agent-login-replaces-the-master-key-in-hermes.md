# ADR-0291: The agent login replaces the master key in Hermes

<status>
Accepted on 2026-11-24 as step 1 of the owner-approved key design ("Approve, start step 1"). Amends
[ADR-0289](0289-chat-page-off-and-hermes-reads-passes-without-the-master-key.md), "Hermes reads passes without the
master key", to "Hermes has no master key". The owner chose a read-only Profiles page for now (8); it is made easy to
reverse.
</status>

## Context

`SERVICE_TOKEN` is Nocheh's master key: the admin bearer of every owner route and the HMAC key of every turn and scope
pass. Hermes and the sealed-turn launcher (`hermes-agent-sb`) held it, so any code running there could act as the owner
and sign passes, against "Agent processes receive no admin credential". ADR-0289 removed Hermes's need to verify passes
and ADR-0290 removed its power to set or fire schedules; what remained were plain service calls in both directions.

## Decision

1. **Three keys.** `SERVICE_TOKEN` stays the admin bearer and pass key, held by `nocheh-app`, `nocheh-security` and (for
   now) `nocheh-telegram`; passes are signed by Nocheh only. `AGENT_KEY`, the agent login, is held by `nocheh-app`,
   `nocheh-security`, `hermes` and `hermes-agent-sb`. `NOCHEH_HERMES_SESSION_TOKEN` opens Hermes's own dashboard (port
   8785) and is held by `hermes` only; the dashboard proxy and owner tools read it from `.env`. Every set key among these
   three, `NOCHEH_BOX_TOKEN` and `NOCHEH_MACHINE_TOKEN` differs from every other; the two new keys are at least 32
   characters. `init`, `up` and `make dev` generate them like the other generated keys.
2. **One agent login, both ways.** Nocheh calls Hermes (`/internal/turn|run/*`, `/internal/manage`, memory recall and
   review, `/internal/schedule/advance`, the helper calls, the broker's `/internal/security/transport`) with `AGENT_KEY`,
   and Hermes calls Nocheh with it. Anyone holding it can pose as Nocheh to Hermes and as Hermes to the agent's routes;
   that is accepted because its holders are Nocheh's own services and the agent's own processes, and it stays far
   short of the owner's authority.
3. **The agent login is its own principal.** On `nocheh-app` it is checked after the workflow transport hook and before
   every other route and before any reader is parsed (`AgentLogin`, never a `Reader`, so no owner check keyed on
   `scope===null` or `admin` can take it). It reaches exactly 22 routes, by method and path with no query string:
   `GET /internal/chats`, `POST /internal/notes/sources`, `POST /internal/sources/retired`, `GET /v1/runtime/profiles`,
   `POST /v1/runtime/profiles/resolve`, `POST /v1/scheduler/{definition,input,workflow-context,claim,prepare,heartbeat,observe,cancel,finish,recover,runs}`
   and `POST /v1/background/{workflow-context,claim,prepare,heartbeat,observe,finish}` (`src/stores/agent-routes.ts`).
   Each runs the same handler the admin bearer reaches. Anything else is 403 `agent_route_not_allowed`: owner and data
   routes, `/mcp`, `/v1/status`, `/v1/agent/manage`, `/v1/ingest`, `/v1/schedules/*` (those take a turn pass through the
   broker), `/v1/scheduler/{ownership,announce,delivery}`, `/internal/chats/leave` and the bot's authorize routes. Only
   four repository calls accept it (`adminOrAgent`): schedule definition and input, profile list and resolve.
4. **On the broker, the agent login reaches only the system guard.** `POST /v1/guard` with `AGENT_KEY` serves Hermes's
   own model calls without a pass (`request_boundary.guard_rpc`), as the admin bearer did; the master key there is now
   403 `agent_login_required`, and the agent login anywhere else on the broker is 403 `agent_route_not_allowed`. The
   broker calls Hermes's transport with `AGENT_KEY` and sends nothing without one (503 `agent_key_unconfigured`).
5. **The admin bearer keeps every route it reaches.** Nocheh's own tools and tests are unaffected; only the broker's
   `/v1/guard` stops taking it, as nothing calls it there.
6. **Hermes refuses the master key.** The Hermes runtime, its native dashboard process and the launcher refuse to start
   when `SERVICE_TOKEN` (or `SERVICE_TOKEN_FILE`) is in their environment, when `AGENT_KEY` is missing or shorter than 32,
   and (Hermes) when the session token is missing, short or equal to the agent login. The native dashboard caches the
   agent login and drops it from its own environment, so the upstream dashboard and its children see the session token
   only. The model's own child never gets either key; the bridge to the launcher gets `AGENT_KEY` only.
7. **Hermes's dashboard has its own session token.** The dashboard proxy sends `X-Hermes-Session-Token` with
   `NOCHEH_HERMES_SESSION_TOKEN`, and the page's `window.__HERMES_SESSION_TOKEN__` is still replaced with the dashboard's
   CSRF value; if that ever missed, only the session token could leak, never the agent login.
8. **Hermes's Profiles page only reads (owner, "read-only for now").** Create, rename and retire on Hermes's own Profiles page
   answer 403 `profiles_read_only`, as its Cron page does since ADR-0290; listing, the active profile and the preference
   and config edits that never call Nocheh stay. Nocheh's side matches: `POST /v1/runtime/profiles` is not on the agent
   list. Reversing it is one check in `native_admin` and one allow-list row, both marked.
9. **Dropped and not granted.** `/v1/memory/spaces` has no handler and its one caller (`native_admin.audience_revision`,
   used only without a profile catalog) is deleted. `/v1/background/cancel` has no Hermes caller and is not granted.
   `/v1/scheduler/runs` stays for Hermes's read-only Cron page; it lists run states for any profile.
   `services/hermes/verify_assistant.py`, which minted passes, is deleted.
10. **Cutover and rotation.** The first `init`, `up` or `make dev` without an `AGENT_KEY` generates the agent login, the
    session token and a new `SERVICE_TOKEN`, so the master key Hermes knew is worthless; the dashboard and executor,
    which cache keys, are restarted. `./bin/nocheh rotate-keys` renews all three and applies them; turns and runs in
    progress, Answer privately buttons on replies still being delivered and replies being delivered fail afterwards
    (development mode accepts this).

## Consequences

- The holder test checks Compose environments only. `hermes-agent-sb` runs as root with the Docker socket and can read
  other containers' configuration, `SERVICE_TOKEN` included, and the management containers read `.env`; a Docker API
  proxy for the launcher is later work.
- In legacy (non-isolated) mode the model's child shares a container and user with the process holding `AGENT_KEY`; the
  environment whitelist is the only separation there.
- `nocheh-telegram` keeps `SERVICE_TOKEN` for now: it checks turn passes and derives Answer privately record ids with it.
  A front-door key and a separate answer-button key are later work.
- A leaked agent login reaches the 22 routes above and Hermes's own internal routes, not the owner's routes, `/mcp`, any
  pass, or a schedule change Nocheh did not grant (ADR-0290).
