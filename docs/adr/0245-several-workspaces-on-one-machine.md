# ADR-0245: Several workspaces on one machine

<status>
Accepted on 2026-11-12. The owner asked "i need multi install to able setup
nocheh for more workspaces, personal, companies", reviewed the design's tables
and said "I just review the tables and seems what I want if there is a
important point or need my answer ask, else start build". This is step 0 of the
members design: one install per workspace, each with its own members later.
Amends [ADR-0036](0036-one-compose-project.md) (one Compose project per
workspace, not per machine) and the single-stack rule of
[ADR-0065](0065-single-stack-source-mounted-development.md),
[ADR-0066](0066-fixed-name-standard-port-development.md) and
[ADR-0073](0073-live-data-source-watched-development.md) (one stack per
workspace). Amends the off-site layout of
[ADR-0229](0229-encrypted-off-site-backup-copies.md) (one folder per
workspace) and the restore port of
[ADR-0023](0023-consistent-backups-and-inactive-restore.md).
</status>

<context>
- Every installation used fixed machine-wide names: Compose project `nocheh`,
  networks `nocheh-agent` and `nocheh-memory`, Honcho volumes
  `nocheh_honcho_database` and `nocheh_honcho_redis`, images `nocheh-*:local`,
  host ports 8780-8785, the off-site prefix `nocheh-backups/` and the dashboard
  cookie `nocheh_session`. A second installation on the same machine shared or
  overwrote all of them.
- `make dev` refused any other running Nocheh project, the Honcho runtime
  refused volumes of another project, and `./bin/nocheh test` ran
  `down --volumes` against the personal Honcho volume names.
- Shell exports of these names won over the folder's own `.env`.
- Browsers keep one cookie jar per host, not per port, so two dashboards on
  127.0.0.1 signed each other out.
</context>

<decision>
- A workspace is one installation in its own folder (a Git clone) with its own
  `.env`, state, Telegram bot, dashboard and backups. `NOCHEH_WORKSPACE` holds
  its name: 1-50 lowercase letters, digits or dashes, set once by `init
  --workspace` or `workspace new`, never changed. A `.env` without it is
  `personal`. A name a person picks may not be or start with a name tests,
  fixtures and restores use (`test`, `tester`, `installation`, `stores`,
  `reset`, `restore`, `restored`, `recovery`, `db-fixture`, `release-check`,
  `candidate`, `preview`, `security-acceptance`, `dev`).
- Everything else follows from the name (`tools/operations/installation/workspaces.py`).
  The project is `nocheh` for `personal` and `nocheh-<name>` otherwise. The
  networks are `<project>-agent` and `<project>-memory`, the Honcho volumes
  `<project>_honcho_database` and `<project>_honcho_redis`, the image prefix
  `NOCHEH_IMAGES=<project>` (services, management, hermes, store-postgres,
  miniapp, box and tools), and the box and tool images Compose hands the
  launcher and executor are that workspace's own. Host ports come from
  `NOCHEH_PORT`: app, viewer +2, dashboard +3 (or `NOCHEH_DASHBOARD_PORT`),
  assistant admin +5. Off-site copies live in `nocheh-backups/<name>/`, and the
  dashboard cookies are `<project>_session` and `<project>_download` with
  dashes as underscores. `personal` keeps every old name, its off-site copies
  in `nocheh-backups/` itself; a listing reads one folder level, so it never
  sees another workspace's copies. The pinned Honcho images stay shared,
  since nothing rebuilds them.
- `compose_environment`, `make dev`, test runs and restores derive these names
  at every run; `.env` and derived values win over shell exports. Only a state
  other than the folder's own (a rehearsal) may still take its project from the
  shell when its `.env` names none. A workspace other than `personal` also
  saves `COMPOSE_PROJECT_NAME` and `NOCHEH_IMAGES` in `.env`, so a plain
  `docker compose ps`, `logs` or `exec` in its folder reaches its own stack;
  only `./bin/nocheh` sets its ports, so it starts and stops it. A `.env` whose project,
  networks, volumes or images differ from its name's was copied from another
  workspace and is refused. A session worktree belongs to the workspace of the
  main checkout its `.git` file names: the `.env` a command writes there takes
  that workspace's name, and a test run from it uses that workspace's images. A
  rehearsal state runs its checkout's workspace images; the dashboard container,
  which cannot see a worktree's main checkout, keeps the images it was started
  with.
- The machine's list is `~/.nocheh/workspaces.json` (or
  `NOCHEH_WORKSPACES_FILE`), mode 0600, written atomically under a lock, with
  only names and folders. A folder that is gone or now holds another name drops
  out. `init`, `up`, `make dev` and the workspace commands add their folder
  after checking the other listed workspaces, Docker and the host. Setup
  refuses another workspace's name or project, published ports, bot (the
  token's ID), mini app address, Cloudflare tunnel (the token's tunnel ID) or
  Honcho folder; ports another program holds (one that takes a connection on
  127.0.0.1, or a bind with `SO_REUSEADDR`, as Docker's, fails, so a
  just-stopped stack's closing connections do not count);
  the same project's containers from another folder that still holds this
  workspace or whose `.env` cannot be read (ones left by a moved folder or a
  session worktree are Compose's to replace); and
  networks or volumes labelled with another project. A `.env` written just now moves to the first free
  block of ten ports from 8780 instead of failing, and is removed again when
  the folder still cannot join, so it can still be named.
- Compose labels `nocheh-telegram` with `com.nocheh.bot-id`, the bot it polls
  (empty while Telegram is off), and `nocheh-tunnel` with `com.nocheh.tunnel-id`
  and `com.nocheh.mini-app-host`. They are `unknown` on a stack started without
  `./bin/nocheh`, and absent on one started before them; both count as possibly
  holding the same bot or tunnel. Settings › Save checks a changed bot token,
  mini app address or tunnel, and turning Telegram on, against those labels on
  running stacks; on the host it also checks the listed workspaces. The dashboard container sees only
  Docker, never other workspaces' folders.
- `make dev` refuses only another project's running `nocheh-telegram` with the
  same bot, or one whose bot it cannot tell; other workspaces keep running. The Honcho runtime
  refuses only volumes and networks labelled with another project, and a
  Honcho restore labels its new volumes with the restoring project. Test runs
  use their own networks, Honcho volumes and the checkout's workspace images.
  The import hand-off checks the workspace's own dashboard port.
- A restore's project must be `nocheh-` plus a valid name that is neither
  `personal` nor a listed workspace's. Without `--port` it takes the first free block of ten; a given port
  whose block overlaps a workspace or a published port is refused.
- Commands: `./bin/nocheh workspace new NAME [--folder DIR]` clones this
  folder's `main` to `../nocheh-NAME`, keeps the origin and the Git hooks, and
  runs `init --workspace NAME` there; it starts nothing.
  `./bin/nocheh workspaces` lists each workspace's folder, dashboard, state
  (running, development, stopped) and code revision; a moved or deleted
  folder drops out. These commands add their own folder to the list only when
  it has a `.env`, so a session worktree stays out; from such a folder,
  `workspace new` needs `--folder` and `update` needs names or `--all`.
  `./bin/nocheh update [NAME ...] [--all]` (default: this folder's workspace)
  skips a folder off `main` or with uncommitted changes, pulls `main`
  fast-forward only, and runs the folder's own `./bin/nocheh up` with a clean
  environment when its stack runs; a stopped one stays stopped and a `make dev`
  stack reloads by itself.
- The setup guide shows Docker's `default-address-pools` setting, because each
  stack makes about seven networks and Docker Desktop's default pools run out
  after two or three stacks.
</decision>

<consequences>
- Workspaces share no data, memory, bot, ports, images or sign-in; one machine
  runs `personal` and company workspaces side by side.
- The personal installation keeps its names, data and off-site copies. Its
  `.env` gains `NOCHEH_WORKSPACE='personal'` at the next `init` or `up`;
  `NOCHEH_BOX_IMAGE` in an old `.env` is ignored. Its running containers get
  the new labels at the next `./bin/nocheh up` or `make dev`.
- Each workspace builds its own images, so several workspaces use more disk.
- Rejected: one checkout serving several workspaces through
  `NOCHEH_STATE_DIR`. Code, images and updates would be shared, and the backup
  writer checks cannot tell two stacks from one checkout apart.
- Rejected: a fixed port per workspace slot. The first free block of ten keeps
  setup automatic and still lets the owner set `NOCHEH_PORT`.
</consequences>
