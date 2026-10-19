# ADR-0161: The Telegram mini app

<status>
Accepted on 2026-10-19. The owner asked for a Telegram mini app to manage
Nocheh with Nocheh's own task manager in it, and chose an address on their
own domain. It follows the owner task list in ADR-0160.
</status>

<context>
The dashboard has no login of its own: it trusts that only the owner's
computer can reach it, and its container can control Docker and read the
whole installation. It must never be public. A phone inside Telegram needs a
public https address.
</context>

<decision>
- The mini app is a separate, small service, `nocheh-miniapp`, with no
  credentials, no Docker access and no installation files. It serves the mini
  app page and forwards a fixed list of owner routes to the dashboard: home
  status, the Inbox and its decisions, and tasks. Settings are read only for
  the owner's own Telegram ID, and nothing else is reachable.
- Every forwarded request carries the launch data Telegram signs. The service
  checks it with Telegram's published Ed25519 key and the bot's public ID, so
  it needs no bot token. Only the owner's Telegram account, within a day of
  launch, gets through.
- The service opens a dashboard session for itself, as the local dashboard
  page does, and renews it when the dashboard restarts.
- Cloudflare's tunnel connector, `nocheh-tunnel`, runs beside it on a network
  shared only with the mini app. It opens an outgoing connection, so no port
  is opened on the owner's computer.
- Both run only when the owner sets the address and the tunnel token in
  Settings › Telegram. Apply starts them and puts the mini app on the menu
  button of the owner's private chat; clearing the settings stops them and
  restores the usual button.
- The mini app reuses the dashboard's own Inbox and Tasks pages, so both front
  ends stay one owner API.
</decision>

<consequences>
- The mini app depends on the local stack: when the computer sleeps, the
  mini app is unavailable.
- Anyone who learns the address sees only the mini app page; without the
  owner's signed launch data every request is refused.
- Settings and System are not available from the phone.
</consequences>
