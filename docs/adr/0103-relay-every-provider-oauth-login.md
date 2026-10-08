# ADR-0103: Relay every provider OAuth login

<status>
Accepted implementation decision. Extends
[0038](0038-observed-telegram-health-and-local-oauth-callback.md) from the
Codex callback to every redirect-based CLIProxyAPI login. Reasoning remains on
the shared ChatGPT login.
</status>

<context>
CLIProxyAPI runs in Docker, but provider redirect URIs name fixed host ports.
Only Codex had a host relay, so a Claude login redirected to an unpublished
`localhost:54545` and never completed. The owner asked that provider login
cover all providers like the ChatGPT login.
</context>

<decision>
The dashboard relays each redirect provider of the pinned CLIProxyAPI through
its own temporary, state-validated listener on that provider's fixed redirect
port and path: Codex `1455/auth/callback`, Anthropic `54545/callback`, and
Antigravity `51121/oauth-callback`. Each relay checks the authorization URL
origin before accepting a state and forwards the callback once through the
authenticated management API. Kimi and xAI use device-code login and need no
relay. A login is refused while that provider already has a credential, so each
provider keeps at most one credential. Shared ChatGPT login status counts only
Codex credentials.
</decision>

<consequences>
Development and operation publish ports 54545 and 51121 on localhost in
addition to 1455. Other providers' credentials can exist beside the ChatGPT
login without changing the reasoning route, speech token selection, or
cutover checks. Using another provider for reasoning would need a separate
decision covering guarding, trusted endpoints, and acceptance.
</consequences>
