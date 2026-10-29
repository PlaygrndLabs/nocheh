# ADR-0190: One owner login for the dashboard and the mini app

<status>
Accepted on 2026-10-29, after the owner answered "all yes" to giving the main
dashboard the same login as the mini app before the server move. Extends and
partly replaces [ADR-0189](0189-mini-app-password.md).
</status>

<context>
- The dashboard had no login: it handed a session to whoever loaded its page,
  relying on binding only to localhost. On an always-on server it is reached
  over a tunnel, so that is no longer enough.
- ADR-0189 gave the mini app its own password, set from the dashboard. Two
  passwords for one owner add a step without adding safety.
- Dashboard sessions lived in memory for 12 hours, so every restart, including
  each live reload in development, would ask for the password again.
- The mini app service opened its dashboard session the same way a browser
  did, by loading the page; with a login it can no longer do that, and it must
  stay without credentials.
</context>

<decision>
- One Nocheh password for both, in the dashboard's state at
  `admin/owner-lock.json`, mode 0600: the scrypt hash from ADR-0189, the
  failure count and pause, and SHA-256 hashes of browser and phone session
  tokens, each marked with its kind. A browser token never works as a phone
  token, or the other way round.
- Signed out, the dashboard page opens on a sign-in screen and carries no CSRF
  value. If no password exists yet, that screen creates it and signs the
  browser in; only the first visit can do that. Native Hermes pages send a
  signed-out browser to the dashboard. The installation token for the CLI
  keeps working as before.
- A browser session is an HttpOnly, SameSite=Strict cookie for 30 days. Its
  CSRF value is an HMAC of the token, so nothing more is stored and a restart
  keeps both. Checks are remembered for a minute; every sign-out and password
  change clears that, so it ends at once.
- Settings › Privacy & data › Password changes the password after checking
  the current one, which counts toward the pause like a sign-in. Every other
  session ends; the browser that changed it gets a new session and CSRF value.
  Sign out everywhere else ends every other session. Settings › Telegram links
  there.
- The mini app forwards each owner call with the phone's own session token in
  `X-Nocheh-Mini-Session` and no cookie. The dashboard checks it and admits it
  only for the mini app's route list; of the settings it returns only the
  owner's Telegram ID. The mini app's sign-in, session check and sign-out are
  dashboard routes that need no session, since the password or the token is
  the check. The mini app service still holds no credential.
</decision>

<consequences>
- After this change the first dashboard visit asks to create the password,
  and the mini app stays locked until then. A password set under ADR-0189 is
  not carried over, in line with development mode.
- A forgotten password is reset by stopping the dashboard and removing
  `admin/owner-lock.json`; whoever then opens the dashboard first creates the
  new one, so it stays reachable only from the owner's own machine or tunnel.
- The synthetic dashboard previews keep their open sessions; the sign-in is
  covered by the HTTP checks and the full tester, which signs in with a
  fixture password.
</consequences>
