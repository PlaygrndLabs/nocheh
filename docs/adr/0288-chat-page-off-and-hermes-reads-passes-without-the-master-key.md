# ADR-0288: The chat page is off, and Hermes reads passes without the master key

<status>
Accepted on 2026-11-24. The owner approved the key design ("Approve, start step 1") and
chose "Switch the page off for now" for the dashboard chat page. Amends
[ADR-0027](0027-native-hermes-dashboard-integration.md) (native chat) and
[ADR-0028](0028-isolated-native-browser-turns.md) (browser turns); both stay as written for
everything else.
</status>

## Context

The key design's first step takes Nocheh's master key (`SERVICE_TOKEN`) away from Hermes.
Today Hermes uses it three ways: as the admin bearer, to check every pass's signature, and
to post browser input as the owner. Hermes's own chat page sends what the owner types
through the browser channel, so a later agent login that can post browser input could
start owner turns. Hermes also mounts every stored file read only, for images in the
non-isolated mode.

## Decision

1. **The dashboard has no chat page until Nocheh has its own.** The owner talks to Nocheh
   in Telegram.
   - Nocheh answers every `/v1/browser/*` path with 404 `browser_chat_off`, before any
     login check. The browser workflow family stays registered, but nothing can be admitted.
   - The dashboard refuses `/hermes/chat` with a short page, refuses every WebSocket
     upgrade (403), has no ws-ticket route and no Chat item in the sidebar. The Hermes
     build turns its embedded chat flag off, so Hermes's own Chat tab is gone too.
   - A browser run left open closes without asking the agent: a waiting one is cancelled,
     a running one interrupted (`runtime_channel_unavailable`). Hermes retires a browser
     receipt it could not publish, and one refused receipt no longer stops the others or
     the schedules.
   - Hermes drops the browser channel: no `NOCHEH_BROWSER_CHAT`, no browser gateway,
     bridge or launcher. Its sockets always close, and `/internal/run/*` accepts only the
     scheduler and background channels.
2. **Hermes has no mount of stored files.** A turn's images come through the broker's
   `/v1/turn-files/<sha>` with the turn's pass in both modes, so Hermes sees only the
   files that pass may read.
3. **Hermes checks a pass's claims, not its signature.** Hermes keeps every claim rule:
   shape, audience, expiry, scope, event, space and revision, generation, guard epoch,
   purpose, profile, project, app binding, and the answer, member and lane rules. It no
   longer needs the master key to read a pass. Nocheh's own services still check the
   signature on every call, so a pass with a wrong signature reads nothing from Nocheh.
   Inside Hermes its claims choose only the turn's local profile, lane and tools, which is
   why every claim must match its binding, and only an authenticated Nocheh caller hands
   Hermes a pass.

## Consequences

- The agent login that replaces the master key in Hermes, the new master key at cutover,
  and schedules fired only by Nocheh follow in later steps of the key design.
- Inbox › History gains no new browser runs; it shows scheduled and background runs.
- Nocheh's own chat page, when built, takes the place of the browser channel. It must
  start turns as its signed-in person through Nocheh, never through the agent.
