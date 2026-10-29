# ADR-0189: The mini app has a password

<status>
Accepted on 2026-10-28, after the owner asked: "better to set a password for
it, can set and change from main dash", then "an auth". Extends
[ADR-0162](0162-telegram-mini-app.md).
</status>

<context>
- The mini app is the only part of Nocheh a tunnel exposes. Until now its one
  gate was Telegram's signed launch data for the owner's account, so anyone
  holding the owner's unlocked Telegram, or a Telegram session on another
  device, could open it.
- The mini app service holds no credentials and has no state; the dashboard
  owns the owner's state and is reached only locally.
- Telegram opens the mini app in a webview; cookies are unreliable there,
  especially in Telegram Web, where it runs in a third-party frame.
</context>

<decision>
- A password, on top of the launch data check, never instead of it. Every
  sign-in, session check and owner call still needs the owner's fresh,
  Telegram-signed launch data.
- The dashboard keeps the password in `admin/mini-app/lock.json` in its state
  folder, mode 0600: a scrypt hash (N=32768, r=8, p=1, 16-byte salt) and, for
  each signed-in phone, a SHA-256 hash of a random 32-byte session token. The
  owner sets and changes it in Settings › Telegram › Mini app with its own
  button, outside the settings that Save writes; it is 8 to 200 characters.
- Without a password, the mini app stays locked and says to set one; it never
  falls back to launch data alone.
- The mini app service signs in, checks and signs out through dashboard routes
  under `/mini-app/lock`. Those routes, and the password and sign-out-all ones,
  are not on the mini app's route list, so the phone can never set the
  password. The phone keeps its token in local storage and sends it in
  `X-Nocheh-Mini-Session`.
- A session lasts until the phone signs out from Home or goes 30 days without
  opening the mini app. At most ten phones stay signed in; the oldest goes
  first. A new password or Sign out everywhere ends every session. The mini
  app service remembers a signed-in answer for 30 seconds, so those reach a
  phone within half a minute; any other answer is asked again each time.
- After five wrong passwords in a row, sign-in pauses for 15 minutes; each
  further wrong one doubles the pause, up to a day. A right password during a
  pause is refused too. One counter covers all phones, since only the owner
  signs in, and it is kept with the hash, so a restart does not reset it. The
  dashboard client never resends a refused sign-in.
</decision>

<consequences>
- After this change the mini app stays locked until the owner sets a password
  in the dashboard.
- Someone with the owner's Telegram on a phone that is already signed in still
  gets in; the owner can end that with Sign out everywhere or a new password.
- Someone who guesses wrong five times locks the owner out for a while too.
  The dashboard shows the pause and when it ends.
- The main dashboard still has no login of its own; it stays reachable only
  from the owner's computer.
</consequences>
