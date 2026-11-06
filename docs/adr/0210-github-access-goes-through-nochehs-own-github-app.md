# ADR-0210: GitHub access goes through Nocheh's own GitHub App

<status>
Accepted on 2026-11-06, after the owner asked for a GitHub App in place of the
pasted personal key. Amends the key part of
[ADR-0209](0209-owner-approved-jobs-read-a-github-copy-in-their-box.md); keeps the
rest of it. Follows the sign-in file pattern of
[ADR-0175](0175-notion-through-its-mcp-server.md).
</status>

<context>
- ADR-0209 copies a repository with a fine-grained key the owner makes on GitHub and
  pastes in Settings › Connections › GitHub.
- That key lives up to a year or never expires. The owner picks its permissions, and
  GitHub has no call that tells Nocheh what they are. The owner must make it again
  when it expires.
- A GitHub App is made once. Its private key never leaves Nocheh, and it asks GitHub
  for keys that last one hour and read only what it asks for.
- GitHub can make an app from a manifest: the browser posts the manifest to GitHub,
  the owner confirms, and GitHub sends the browser back with a one-time code that
  Nocheh trades for the app's id and private key.
- Each Nocheh installation must hold its own key, so each makes its own app.
</context>

<decision>
- **Connect GitHub.** Settings › Connections › GitHub has one Connect GitHub button.
  The dashboard asks Nocheh for a manifest and posts it to GitHub's create page for
  the owner's account, or for an organization the owner runs when one is typed in. The
  manifest makes a private app named `Nocheh-` and 6 random hex characters, with
  Contents and Metadata read-only, no events and no webhook. Its return and setup
  addresses are the dashboard's `/connect/github`, which must be http on localhost or
  127.0.0.1, or https.
- **The way back.** Nocheh keeps a random state for 30 minutes in
  `<state>/admin/connections/github.json`. `/connect/github` needs no session: it
  forwards only a well-formed code, state, installation id and setup action to the
  dashboard's card. A tab GitHub opens comes without the session cookie, so, as with
  Notion's sign-in, it first gets a page that opens the same address again. The card
  sends the code and state back. Nocheh uses up the state at once, then trades the
  code once for the app's id, slug, account and private key. The key must be RSA of at
  least 2,048 bits. The client secret and webhook secret GitHub also sends are never
  kept. While the code is traded, the file marks that sign-in as running: a Disconnect
  or a new Connect meanwhile removes the mark, and the app is then not kept. When
  Nocheh is busy with a backup or a restart, or does not answer, the card keeps the code
  in the address, so reloading the page finishes the sign-in.
- **The signing library.** Connect checks that Nocheh can sign with the key before it
  sends the owner to GitHub, so an image built before the app asks for a rebuild
  without making an app on GitHub.
- **Choosing repositories.** The browser then goes to the app's install page on
  GitHub, where the owner picks the repositories. The way back lists what the app may
  read. Choose repositories on the card opens that page again.
- **Short repo keys.** For each call, Nocheh signs a token with the app's key: RS256,
  issued 60 seconds back, for 9 minutes. With it, Nocheh asks GitHub for a key that
  lasts one hour. A list asks for Metadata read-only across an installation. A copy
  finds the repository's installation and asks for Contents and Metadata read-only on
  that one repository. That key takes the pasted key's place in ADR-0209's fetcher,
  unchanged, and is never stored. A list reads at most 10 installations, 3 pages of
  100 each, and skips suspended ones.
- **Refusals.** When GitHub refuses the app's own token, the card asks to connect
  again and one problem notice says so. The key is kept: a computer clock that is
  wrong by more than a minute also makes GitHub refuse the token, and GitHub hands the
  key over only once. The hourly check tries the app once; when GitHub takes it again,
  it is connected again. Until then nothing else uses it, and the card links to the
  app on GitHub. When git refuses a short key (ADR-0209's exit 10), the copy fails
  with `github_repo_not_readable` and the app stays connected. The expiry notice is
  gone: the app's key does not expire.
- **One app at a time.** Every step that read the app checks before it saves that the
  same app is still connected, so work started before Disconnect or a new Connect never
  writes into the next one. No lock is held across a GitHub call, and Connect does not
  wait for the GitHub lock.
- **Disconnect** forgets the app and its key. GitHub has no call that deletes an app
  with its own key, so the card then links to the app's settings page on GitHub to
  delete it there.
- **Where it runs.** The management image gains `python3-cryptography` to sign the
  token. The guard already masks GitHub's short key shapes and private keys.
</decision>

<note date="2026-11-06">
- Unit tests sign real RS256 tokens against a fake GitHub that checks them. The full
  tester's fake GitHub makes its app key with openssl, checks every token against it
  with plain RSA arithmetic, and gives each short key only what was asked for.
- The full tester posts the manifest, follows `/connect/github` both ways, installs
  the app and copies through a one-repository key. It searches the box, its turns, the
  launcher, the database and every dashboard answer for a line of the app's key and
  every short key, and finds none.
</note>

<alternatives>
- **Keeping the pasted key.** It lives long, Nocheh cannot see what it allows, and the
  owner must make it again when it expires.
- **One public app for every installation.** Its private key would have to be shared
  with every installation.
- **Signing in as the owner.** A user token reads everything the owner can read, not
  only the chosen repositories.
- **Webhooks.** They need an address GitHub can reach. The hourly check already
  copies again when a branch moves.
</alternatives>

<consequences>
- The owner presses one button and picks repositories on GitHub. There is no key to
  make, paste or renew.
- The app's key does not expire. Whoever reads `github.json` can read the chosen
  repositories until the owner deletes the app or makes it a new key on GitHub, as
  with the pasted key, but never more than read access to the chosen repositories.
- A fetcher taken over in its step 2 (ADR-0209's D4) holds a key that reads one
  repository for at most one hour.
- A private app can only be installed on the account that made it. A repository in an
  organization the owner does not run needs that organization's owner to make the app.
  Still open.
- A dashboard on plain http at another address cannot connect GitHub.
- Disconnect does not delete the app on GitHub; the owner deletes it there. A new
  Connect after a refusal, or a sign-in that did not finish, also leaves an app on
  GitHub to delete.
- A deleted app stays in the file until the owner connects again or disconnects, and
  the hourly check asks GitHub about it once an hour.
</consequences>
