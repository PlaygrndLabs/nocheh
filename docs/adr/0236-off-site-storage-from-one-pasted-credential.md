# ADR-0236: Off-site storage from one pasted credential

<status>
Accepted on 2026-11-11, after the owner asked for off-site copies that are
configurable and set up through a Cloudflare connect or sign-in, or a better way.
Builds on [ADR-0229](0229-encrypted-off-site-backup-copies.md): encryption, upload,
the restore test and recovery stay as they are.
</status>

<context>
- Setting up ADR-0229 meant creating a bucket and a bucket-only key by hand, then
  typing the storage address, bucket, region, key ID and secret.
- Cloudflare lets outside apps register an OAuth sign-in, but a public one needs a
  verified website owned by the project, and the scopes such an app may ask for
  cannot create the API tokens R2's S3 keys come from. Sign-in alone gives no
  upload key.
- Cloudflare documents token links that open its "Create API token" page with
  permissions already chosen, a REST API that creates buckets and bucket locks and
  makes further tokens, and S3 keys taken from any API token: the token's id, and
  the SHA-256 of its value.
- Backblaze's account authorization answers with the S3 address and the buckets a
  key may reach.
- Google's API terms forbid shipping a client ID in an open-source project, iCloud
  Drive has no API, and a desktop sync folder cannot confirm an upload reached the
  cloud.
</context>

<decision>
- Off-site copies have a storage choice, `NOCHEH_OFFSITE_PROVIDER`:
  `cloudflare` (default), `backblaze` or `other`. Other S3 keeps the ADR-0229 fields.
  The choice works live, like the other off-site settings.
- Cloudflare: "Open Cloudflare" opens an account-token page already filled in with
  Workers R2 Storage Edit and Account API Tokens Edit. The owner creates the token
  and pastes it into the dashboard. `offsite_connect.cloudflare` then:
  - lists the accounts the token reaches and asks which one when there are
    several, or for the account ID when Cloudflare names none;
  - checks first that the token can make tokens, so a token without that
    permission leaves nothing behind;
  - keeps the bucket an earlier connect saved. Otherwise it creates
    `nocheh-backups`, or `nocheh-backups-` plus 8 random hex characters when a
    bucket of that name already exists: another installation may keep and prune
    its own copies there;
  - adds the bucket lock rule `nocheh-copies`: objects under `nocheh-backups/`
    cannot be deleted or replaced for 7 days, and the owner's other rules on the
    bucket stay. When the existing rules cannot be read, nothing is written;
  - creates the token "Nocheh off-site copies" with Workers R2 Storage Bucket Item
    Write and Read on that bucket only, and writes, reads back and removes a test
    object with its S3 keys, retrying while the new key starts to work;
  - saves the storage address, bucket, region `auto` and the keys, then deletes
    the key an earlier connect saved, only when Cloudflare names it "Nocheh
    off-site copies", and the setup token. If Cloudflare refuses to delete the
    setup token, the dashboard says so with a link.
  The setup token is never saved, logged or returned. A key that fails its test is
  deleted and nothing is saved.
- Backblaze: the owner pastes a key ID and application key. Nocheh asks Backblaze
  for the S3 address and the key's bucket, refuses a key that reaches more than one
  bucket or cannot write, tests the key and saves it. The dashboard tells the owner
  to set the bucket's lifecycle to keep only the last version.
- Connecting is `POST /offsite/connect` (`offsite.connect`). It takes the same
  writer lock as Save and refuses while a backup or restore runs. It writes only
  the storage settings: turning copies on and the passphrase stay the owner's
  own edits, saved with Save. The answer carries the new settings view and the
  revision it saved on, so other unsaved edits on the page stay, and still meet
  a conflict when another page saved in between. Choosing Cloudflare or Backblaze
  saves nothing by itself; only Other S3 is saved with Save.
- After a copy, pruning keeps a copy the storage refuses to delete because of its
  lock (`ObjectLockedByBucketPolicy`) and counts it as `locked`, not as an error.
  A later copy removes it once the lock ends.
- Sending a backup again while its earlier copy is locked keeps that copy and
  counts it as sent, when the storage lists it under the same key.
</decision>

<consequences>
- Cloudflare setup is one created token, one paste and the passphrase. The
  machine keeps a key that can only read, write and delete objects in one bucket,
  and that key cannot change or remove the lock. Whoever takes the machine can
  delete copies only after they are 7 days old.
- The setup token can create tokens while it exists. Nocheh deletes it once
  connecting succeeds. After a failed connect it stays so the owner can try again,
  and the dashboard links to Cloudflare's token list to delete "Nocheh setup".
- A bucket can hold more copies than the number to keep while young ones are
  locked.
- A connect that stops after making the bucket leaves that bucket, and the next
  connect makes one with a random ending.
- Backblaze keeps every version of a file unless the bucket's lifecycle says
  otherwise, so a removed copy uses space until that setting is changed.
- Settings saved by hand under ADR-0229, before the storage choice existed, show
  as Cloudflare until Other S3 is chosen and saved. Nocheh is in development mode,
  so nothing converts them.
- R2 must be turned on in the Cloudflare account once, in Cloudflare's own
  dashboard.
- On a new machine, the owner creates an R2 token for the bucket the dashboard
  named in Cloudflare and gives its S3 keys to `nocheh offsite fetch`, as in
  ADR-0229.
- A real "Sign in with Cloudflare" can replace the pasted token if Cloudflare lets
  outside apps create bucket keys.
</consequences>
