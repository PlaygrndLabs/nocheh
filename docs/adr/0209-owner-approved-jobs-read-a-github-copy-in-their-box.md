# ADR-0209: Jobs the owner approved read a GitHub copy in their box

<status>
Accepted on 2026-11-05, as step 4 of the steps the owner chose with "All three, in
order" so Nocheh works like a Claude Code session: a background job compares a
group's tasks with the code, and searches the code and its git history. Extends
[ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md),
[ADR-0207](0207-a-background-job-is-one-hermes-run.md),
[ADR-0208](0208-running-jobs-carry-across-quiet-epochs.md) and
[ADR-0175](0175-notion-through-its-mcp-server.md), whose sign-in file
pattern the GitHub key follows. Keeps
[ADR-0206](0206-nocheh-prices-a-jobs-model-use-itself.md).

The owner has not yet answered four questions. Nocheh is built as recommended until
they are answered:
- **D1.** Check for new commits every hour, or copy only when the owner presses
  Copy? Built: also every hour, and copy again when the branch moved.
- **D2.** Secret-check code before it goes into the box? Built: no. Everything the job
  reads is checked before the model sees it.
- **D3.** May a job run the repository's own code? Built: only when the instruction
  asks for it.
- **D4.** May the copy step reach only GitHub? Built: not now. This ADR states what
  the fetcher can reach.
</status>

<context>
- The owner wants jobs to compare a group's tasks with the code: search code and
  git history.
- The box has no network and no keys (ADR-0205).
- A job is one run, relaunched at most twice. Each run usually gets a new box, and
  its /chat is filled once (ADR-0207). A running job's run carries across quiet
  epochs (ADR-0208).
- Hermes's GitHub skill and plugins read `GITHUB_TOKEN` inside the agent. A token
  there would reach every turn.
- No management container may parse repository data next to the Docker socket.
</context>

<decision>
- **The key.** The owner pastes a fine-grained GitHub token in Settings ›
  Connections › GitHub. It stays in `<state>/admin/connections/github.json`, mode
  0600, and no view returns it. Its permissions are the owner's choice. The card asks
  for Contents: Read-only on only the chosen repositories, and says that Nocheh only
  reads but cannot check what else a key allows: GitHub has no call that lists a
  fine-grained token's permissions. The card shows the login and the expiry date. A
  refused key, or one that expires within 7 days, raises one problem notice.
- **Where copies come from.** Only Settings (Copy, Copy again) and the hourly check
  (D1) make copies, never chat. At most 10 copies are kept.
- **The fetcher.** A fresh container of the box image fetches each copy. It runs as
  uid 65530 with no mounts, every capability dropped, a read-only root, `--dns
  127.0.0.1` and GitHub pinned with `http.curloptResolve`. It runs on its own
  `nocheh-repo-fetch` network with inter-container traffic off. The key reaches it on
  stdin, and only its fetch step (step 2) holds it, in that child's environment. The
  auth header is scoped to `https://github.com/` and redirects are off. The fetcher
  sends back a framed `git bundle` of the default branch. Nothing with the Docker
  socket or Nocheh's state runs git on that data.
- **What is kept.** A copy is kept only at the commit GitHub's API names for the
  branch. The bundle is stored by its sha256 in `<state>/github/copies`. A copy
  is kept only if its `need` (tmpfs pages, the pack and its index) fits in `/repo`'s
  256 MiB less an 8 MiB reserve, and its files and folders fit 65,536 inodes less
  1,024. The bundle is at most 64 MiB, with at most 50,000 files of at most 64 MiB
  each.
- **One strict check.** Every copy passes one explicit `git fsck --strict`, ignoring
  only `zeroPaddedFilemode`, in the fetcher and again in the writer. Transfer fsck is
  off, because its behaviour differs between git versions. The writer also refuses any
  object the commit cannot reach.
- **The pin.** Each copy row has a random `copy_id`. `start` takes `repo` with `box`
  and pins the copy's `copy_id`, name, branch, commit and sha256 in the job row and its
  fingerprint. The card says so:
  `📦 It reads a copy of example-org/widgets, main at 3f2a91c, copied … (18 MB, 1,204
  files)…`, and the 🧰 line says the box holds the copy. Every run of the job reads that
  pin, even after a later Copy again. A later Copy of the same name gets a new
  `copy_id`, so it never revives a removed copy.
- **Taking it away.** Remove and Disconnect are final for the jobs that pinned the copy
  and never wait for a copy or the hourly check. They withdraw cards not yet approved,
  stop approved jobs that have not started, and remove running jobs' boxes within about
  15 s. The store decides atomically whether a finished copy may still be saved: a
  copy saved after its `not_after`, or for a removed `copy_id`, is refused. A copy
  reads its row before it asks GitHub, and the hourly check updates only the
  `copy_id` it saw. The store numbers every Remove, also one that finds no row, and a
  new copy names the last number it read, so a Remove of its name after that refuses
  it.
- **The launcher** reads only the digest the binding names, from the read-only
  `/repo-copies` mount, and checks the file's size. The writer checks its sha256 as it
  receives it.
- **The writer.** `box_repo.py`, run in the box as uid 65531, clones the copy into a
  `/repo` tmpfs of 256 MiB with 65,536 inodes (`noexec,nosuid,nodev`). It runs in its
  own thread beside the /chat fill, and its time ends 60 s before the run's hard
  deadline, at most 600 s. It writes `/repo/code`, a read-only checkout with no remote
  and the branch's full history, then `/repo/manifest.json` last. A repo box gets
  512 MiB more memory, 1.5 GiB in all.
- **git in the box image**, with `core.symlinks false`, hooks, fsmonitor and protocols
  off, capped threads, and `safe.directory` for both `/repo/code` and
  `/repo/code/.git`.
- **The guard** masks GitHub token shapes.
- **`allowed_path`** gains background-jobs, so System › Background work's routes pass.
- **No new tool.** Hermes reads the copy with its own terminal, file and code tools,
  git and rg. The run text tells it how the copy stands, and that to change files it
  clones the copy with `git clone -q --shared /repo/code /work/code`.
</decision>

<note date="2026-11-05">
The spike ran on the built box image, on a Linux host with Docker 29.9.2 and cgroup
v1, with made-up data. It changed no constant.
- git 2.47.3 adds 31 packages, perl among them, and the image grows from 186 MB to
  326 MB. The setuid sweep still passes.
- log, grep, blame and status need `safe.directory` for `/repo/code`, and clone needs
  it for `/repo/code/.git`. A shared clone of the largest copy takes 67% of /work; a
  plain one takes 93%, so the run text names `--shared`.
- `/repo` pages and inode memory count against the box's memory, about 950 B per
  inode. An OOM never frees /repo; it kills the largest process.
- Docker accepts and enforces `nr_inodes=65536`. A git child's errno never reaches
  the writer, so after a failed git step it reads statvfs: fewer than 1,024 free
  inodes or less than 8 MiB free, or git killed by SIGXFSZ, means the copy did not fit
  (exit 4).
- The largest copy (a 67 MB bundle, 50,000 files, 14,512 folders, 147,843 objects) used
  95% of its `need` in /repo. Its peak over an idle box was 363 MiB of the 512 MiB
  added. A 170,001-commit history peaked at 312 MiB.
- On one CPU the largest copy took 12 s alone and 25 s beside a busy command. The dense
  history took 52 s beside a busy command, under the 240 s bound.
- The /chat fill ran 2.73 pages a second alone, and 1.4 to 1.6 beside a copy for about
  18 s: about 280 pages in its 120 s instead of 300.
- A killed launcher's startup sweep removed a box mid-copy, its volume and its writer.
- Against a local fake GitHub, the pinned fetch sent its header only to the pinned
  address, followed no redirect and had no DNS. git never prints 401: a wrong key gives
  "could not read Username … terminal prompts disabled", so exit 10 matches that line.
- What a fetcher can reach (D4): DNS fails, and peers on the same network and
  containers on other bridges time out. The bridge gateway on any port, the host's LAN
  address, the LAN gateway, 169.254.169.254:80 and public addresses connect.
- Not measured: Docker Desktop's `enable_icc`, whether AppArmor blocks same-uid
  environment reads, a relaunch's start latency through the whole stack, and smart HTTP
  against real GitHub.
</note>

<alternatives>
- **`GITHUB_TOKEN` for Hermes's own GitHub skill.** Every turn could read the key, and
  a group message could steer it.
- **Cloning in the dashboard or management container.** That container holds the
  Docker socket and Nocheh's state, and git would parse repository data next to them.
- **A copy fetched for each job from chat** (D1's third answer). A chat message could
  then make Nocheh use the key, and it needs a new workflow.
- **Secret-checking every file and its history before the copy** (D2's second answer).
  Many model calls and minutes to hours per copy.
- **A relay that forwards only to GitHub** (D4's second answer). One more container
  and network per copy, and more tester work. Left to the owner.
- **Refreshing /repo during a run.** A run reads one pinned commit; a relaunch's new
  box copies the same bundle again.
</alternatives>

<consequences>
- Code reaches the model only through the secret check. The copy's name, branch and
  commit enter the card and the run's first message unchecked, through
  `prepared.allow`. They come from GitHub's API and pass the name and branch patterns.
- A key committed in a repository reaches the model masked. In the tester, Hermes's own
  redaction of tool output masked a classic key first, keeping its first 6 and last 4
  characters; the guard masks any key shape left whole.
- /chat keeps its whole fill time. A run's start may wait up to the fill time for a
  large copy, and that time comes off the job's soft deadline. A copy still running
  then lands beside the run, and the job sees `copying` until it does.
- The writer shares the box's CPU, memory and processes with the job's commands. They
  can starve or kill a copy. That is self-inflicted and never changes what lands.
- A relaunch after an abnormal end, or after a change that is not quiet, gets a new box
  and copies the bundle again: up to 3 copies per job, each at most 2 sends. /work is
  empty again, so a clone there is gone.
- Remove during a run removes the box within about 15 s. The run goes on with failing
  box tools and keeps what it already read. Remove withdraws the copy, not what was
  read and checked. What jobs already read stays in their runtime_context artifacts,
  their Hermes sessions and backups, and the Remove and Disconnect confirm texts say so.
- Code reads count in the run's per-call tokens and in ADR-0206's byte backstop. The
  estimate does not count the repository, so a code-heavy job reaches the 80% notice
  or the limit note sooner.
- Some old repositories fail the strict check, for example a commit with a malformed
  date, and cannot be copied.
- Still open: code enters the box unchecked (D2).
- Still open: raw tool output, including any committed secret, is kept in
  runtime_context artifacts, as all tool output is.
- Still open: a fetcher taken over in its step 2 holds the key and can reach the host
  gateway, the LAN and link-local addresses such as 169.254.169.254 on any port (D4).
  Steps 3 to 8 never hold it, but step 2's connectivity walk parses commits and trees.
- Still open: `/work/.gitconfig` overrides `/etc/gitconfig`, and a `.profile` there runs
  at the next login shell. The run text says never to copy the repository into /work
  itself.
- Still open: there is no gVisor (ADR-0205), and the secret check of code reads is not
  counted in the job's cost (ADR-0205).
- Still open: installs that reach the internet only through a proxy cannot copy.
- Only the default branch and one repository per job. No LFS content, no submodules
  and no real symlinks: they arrive as pointer files, empty folders and small files.
</consequences>
