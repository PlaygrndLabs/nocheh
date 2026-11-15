# ADR-0251: Fixes that lose nothing

<status>
Accepted on 2026-11-14, as the second set of fixes from the review of how text
from outside reaches Nocheh and what it can touch
([ADR-0250](0250-cards-and-forwards-say-whose-words-they-are.md) was the first).
The owner approved each fix with what it would lose. Each one keeps what works
today. Extends [ADR-0030](0030-configurable-space-memory.md) with the words the
sharing filter sees. Supersedes the shared-result parts of
[ADR-0138](0138-shared-context-detection.md) and
[ADR-0170](0170-secret-check-results-survive-guard-epochs.md), and
[ADR-0190](0190-one-owner-login.md)'s one sign-in count for browsers and phones.
Narrows [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md) (members
not allowed are still prepared) and
[ADR-0193](0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md) with
the voice cap, without editing them.
</status>

<context>
- Hermes reads untrusted text and files, and its container could write its whole
  image and see the dashboard's folder, which holds the dashboard token, and the
  whole spool.
- A command an approved job ran could leave a link or a special file in its
  workspace. A backup then stopped, and nobody was told.
- Telegram sends a photo as several sizes; each was downloaded and read. A
  stranger's long voice note was transcribed whole, at the owner's cost, timed by
  the length its sender states.
- A member's job could spend without the owner hearing of it; its cap rounded to
  whole dollars.
- The automatic sharing filter read the asker's whole question, so the question
  could argue with the filter. The sharing and Notion texts promised more than
  the code does. Recalled notes did not say which chat they came from.
- A secret-check result found in a batch of several texts was shared with every
  other chat. A planted text could make the check mark a request's own field
  names, such as `role`, as secrets and break every later request.
- Hermes's pages had no script rules. The database viewer had no login. One count
  of wrong passwords paused sign-in for both the browser and the phone.
</context>

<decision>
Hermes container
- Hermes runs with a read-only root, a 1 GiB memory `/tmp` (mode 1777), no
  capabilities and no new privileges. `HOME` is `/tmp/home`, made at start and
  holding only caches; `make dev` keeps its mounted home.
- It writes only `HERMES_HOME`, `/reports`, `/data/spool/brain-turns`,
  `/dashboard-state/home` and `/tmp`. Only `admin/dashboard/home` and
  `spool/brain-turns` are mounted, not their parents.
- `runtime_folders()` makes every mounted folder at 0700, one level at a time,
  before Docker could make one as root: from init and up, restore (before the
  snapshot is extracted) and `make dev`.
- On-first-use installs stay as they are: they go to Hermes's own mounted
  folder, not the read-only image.
- Each document, image and voice read runs in its own temporary folder, removed
  after the read, timeouts included. A read that fails because `/tmp` is full
  (ENOSPC, EDQUOT, or a free-space check after an unexplained failure) or a write
  was refused (EROFS) keeps today's status, is counted per day and reader in
  `reader_daily` in `usage.sqlite`, is no model call, and gives one Telegram
  problem line per reader and cause, also on System › Health. Errors are told
  apart by number, never by message text.

Backups
- A link inside a profile's workspace is kept as a link, listed in the manifest
  with its target, never followed, and made last on restore. A link elsewhere
  stops the backup with `backup_unsupported_link`.
- FIFOs, sockets and devices are skipped and listed. A hard-linked file is
  stored as plain copies. An entry a command made unreadable inside a workspace
  is left out and listed; elsewhere it still fails the backup.
- Restore checks every member against the manifest, writes each file new with
  `O_EXCL|O_NOFOLLOW` at 0600 through folders opened one at a time, and refuses
  hard links, devices, FIFOs, folders, unlisted links and anything below a link.
  Old backups restore as before.
- Failures have fixed codes (`backup_unsupported_link`, `backup_disk_full`,
  `backup_interrupted`, `backup_failed`); the command line prints only the code
  on stdout and the cause on stderr. `admin/backup-health.json`, outside the
  copied folders, records each backup, including one that cannot start.
- Every backup that does not finish, every automatic backup skipped for low
  disk, every newest backup that left entries out, and every failed or skipped
  off-site copy gives a Telegram notice with a fixed reason, never a file name,
  marked fixed by the next good one. System › Health and System › Backups show
  them; System › Backups warns on low disk and keeps Back up now.

Photos and voice notes
- A photo, new group photo, paid photo or video cover, sent as several sizes of
  one picture, is downloaded, read and checked once, at its largest size. The
  other sizes stay listed in the archived update. A list of other files keeps
  them all.
- Once Telegram access is set up, a recording captured live from someone not
  allowed in that group is transcribed up to its first 15 minutes
  (`VOICE_LIMIT_SECONDS`). Anonymous admins, posts in a chat's own name, bots
  and unknown senders count as not allowed. The owner's and allowed people's
  recordings, imports and restores are transcribed whole; the original is always
  kept. `allowedSender` in `src/assistant-policy.ts` is the one shared sender
  check.
- The cut is timed by the decoded samples, never by the stated length: first
  audio stream only, local files only, timestamps rebuilt from the samples,
  16 kHz mono Opus. Only the cut reaches the provider, and usage counts the
  cut. A cut that fails is a counted failure (`nocheh_error`, cause
  `audio_cut`) with the usual notice; the recording is never sent whole. The
  transcript ends with a fixed note; a new reading from the dashboard, or a
  forward to the private chat, gives the whole text.

Member job spend
- A member's job cap is the larger of the owner's cost limit and 1.5 times the
  estimate, in whole cents rounded up; cards show it to the cent. The owner's
  own jobs keep whole dollars.
- `member_notice_usd` (default 20) and `member_pause_usd` (default 100) are
  settings; the pause mark is at least the notice mark. Today's spend (UTC) is
  the cost of runs of jobs a member asked for and approved themselves.
- Past the notice mark the owner gets one private Telegram notice a day with
  Pause; past the pause mark member jobs pause until 00:00 UTC and the owner gets
  a notice with Resume. Every tick of a member job, held or running, checks the
  spend, and a notice that did not go is sent again, once per day and mark, on
  the next tick or from the storage worker within a minute.
- A pause is a hold: approved member jobs wait, with a card line, and start when
  it ends. Nothing is refused. The owner's jobs and member jobs the owner
  approved never wait. The owner pauses and resumes from the notice or the
  Background work page (`POST /v1/background-jobs/member-pause`, owner only).

Sharing, Notion and recall
- The sharing filter's model gets only the words Postgres searched for: the
  lexemes of `to_tsvector('simple')`, each once, the 12 longest, sorted, as a
  JSON list `search_words`. The saved record keeps the raw question. The
  default filter prompt calls them untrusted; the cut in code is the guard.
  ADR-0030's accepted residual stands.
- The Filter automatically hint says people in these chats can talk the filter
  into passing more. Privacy notes show in the dialog only for the filter, and
  are always kept and shown in the rule's panel.
- The Notion "Ask me first" text says an outside read asks like a change unless
  Nothing asks me is picked, and always asks in a background job; a warning
  shows while Nothing asks me is picked. Behaviour is unchanged.
- Each recalled note says where it came from: the owner's private chat, a group
  or topic by name, or a private answer and the group it was asked in. A private
  answer never gets the owner's label.

Secret check
- An AI finding never masks a payload's object keys, or a model request's role,
  type, name, model or tool id values outside a tool's input; the fixed secret
  patterns still do. A stored guarded copy follows the same rule.
- A text's result is shared with other chats when the batch held that text
  alone, or nothing was found beyond the fixed patterns. A finding from a batch
  of several texts is checked once more on that text alone, at most 3 a batch,
  side by side, and shared when it covers the batch's finding. Otherwise the text
  is held back, and every other chat checks it itself until a check of it alone
  confirms a finding. Each text has two first-write-wins shared rows: its result,
  and the confirmed finding. A provider failure of that check is a failed Secret
  check call, with the usual notice; the turn goes on.

Web pages and sign-in
- Hermes's own pages get a Report-Only script policy with a new nonce on each
  response; any other page from Hermes runs no script. Reports are counted, with
  no page text, and `./bin/nocheh diagnose` shows them. After about a week with
  none and a passing tester run, one commit turns the policy on; the tester
  check stays a gate on every Hermes update.
- The database viewer asks for a login (`owner`, a 64-hex password kept in
  `.env`); `./bin/nocheh db` prints it, and `up` gives a running viewer its
  login. Its restart policy, network and port are unchanged.
- Wrong passwords are counted per person: the browser, and each phone by its
  Telegram id, checked against Telegram's signed launch data. Launch data that
  is missing or wrong never counts. `./bin/nocheh dashboard --clear-pause` ends
  every pause.
- A separate dev builder is not built; the rule against a builder service
  stands.
</decision>

<consequences>
- Hermes cannot change its image or read the dashboard token. Its caches empty
  on each restart, and a full `/tmp` reaches the owner as a notice.
- Backups no longer stop on a command's link or special file, and every one that
  fails, is skipped or leaves something out reaches the owner.
- Photo reads cost about a quarter. A stranger's long recording costs at most 15
  minutes; the owner's own note posted as an anonymous admin is cut the same way.
  A person allowed later keeps earlier cut transcripts until a new reading.
- Past the pause mark, approved member jobs wait until midnight UTC or Resume.
- The filter judges from up to 12 search words, not the sentence.
- An AI-only finding in a key or request field is not hidden there. A finding
  that only a neighbouring text made possible protects only the chat that found
  it; each other chat checks that text itself. A batch with findings costs up to
  3 more quick checks.
- The database viewer asks for a login once per browser. Sign-in pauses no
  longer cross between the browser and the phone.
</consequences>
