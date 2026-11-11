# ADR-0231: Owner-approved jobs work on the owner's machines over SSH

<status>
Accepted on 2026-11-10, after the owner asked to let Nocheh set up projects in
their VM. The owner chose on 2026-11-10 that Nocheh takes no snapshots of a
machine. Extends the sealed box of
[ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md), the one run of
[ADR-0207](0207-a-background-job-is-one-hermes-run.md) and the pin of
[ADR-0209](0209-owner-approved-jobs-read-a-github-copy-in-their-box.md).
Replaces the public-address rule of
[ADR-0029](0029-controlled-tool-execution.md) for machines the owner registers,
and only for them. Adds a length limit to every job's card
([ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md)). Keeps
[ADR-0203](0203-owner-approved-jobs-read-notion.md) and
[ADR-0225](0225-member-safety-rules.md) for Notion,
[ADR-0206](0206-nocheh-prices-a-jobs-model-use-itself.md) for cost, and the
follow-ups of [ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md).
</status>

<context>
- The owner wants to ask in chat for work on a VM they run, such as setting up a
  project: install tools, fetch code, build it and start it. They want to approve
  that work once, not each command.
- The sealed box has no network and no keys (ADR-0205), so it cannot reach a
  machine.
- ADR-0029 lets remote operations reach public HTTPS addresses only, with a card
  for each operation. A VM usually has a private address or runs on the same
  computer as Nocheh, and setting up a project takes many commands.
- Hermes has its own SSH terminal backend. It reads its key from the turn's own
  environment, where the model's commands run.
- Turn containers run on an internal network without DNS. No Nocheh image had an
  SSH client.
- A Hermes terminal backend gets Hermes's wrapped scripts, not only the commands
  the agent asked for. Hermes's file tools and its session setup also run
  commands through it.
- The owner freedom setting and standing permissions approve controlled
  operations without a card. A follow-up turn (ADR-0212) passes every live-turn
  check as if the owner had asked.
- A job's card had no length limit. Telegram refuses a card over 4096 characters,
  the refusal was swallowed, and such a job could never be approved.
- SSH without a terminal leaves a remote command running when its connection
  closes. Stop alone would leave programs running on the machine. A program a
  command starts in the background also keeps the connection open while it
  holds the command's output.
</context>

<decision>
- **Machines.** In Settings › Machines the owner adds a machine with a name, an
  address, a port (22 by default) and a login, for example `build-vm`,
  `192.0.2.10`, 22 and `nocheh`. The address is an IP address or a host name;
  `host.docker.internal` reaches a machine on the computer that runs Nocheh.
  Nocheh connects from its own container, so the form flags `localhost`,
  `127.x.x.x` and `::1` and says to use `host.docker.internal` instead.
  Names are unique, ignoring case. Nocheh makes an ed25519 key for each machine
  and shows only its public key, to add to that login's
  `~/.ssh/authorized_keys`. **Test** runs `uname -srm`. The first good test
  trusts the host key the machine shows, and every later connection must show
  the same key. **Trust a new host key** forgets it, so the next Test trusts the
  new one. **Edit** changes the name, address, port or login. A new address,
  port or login forgets the host key too, after a confirm, and the machine
  needs a new Test; its key stays, so the same public key works. A new name
  alone changes nothing else. Trusting a new host key and changing the address,
  port or login stop the machine's jobs, as under **The pin**. A machine is
  ready, and the page shows
  **Ready**, when it is on and its last Test passed. After a failed Test no new
  job can ask for it until a Test passes again.
- **Who may ask.** Only the owner's own message can start a machine job: in
  their private chat, or in a group or topic of an active project. The agent
  calls `nocheh_background_job` with `machine`, a machine's name, and `steps`, a
  plan of 1 to 12 short steps. In such a turn, the status action lists the
  machines and whether each is ready. The store refuses with
  `job_machine_not_allowed` a member's request, a follow-up turn, a chat outside
  an active project, a job that also asks for the box, and any request while
  machine control is off or its token is missing. A job's own run cannot start a
  job at all (ADR-0197). The tool refuses `machine` outside the isolated runtime
  with `isolated_runtime_required`. A machine that is off, unknown or not ready
  gives `job_machine_not_found`, and the answer tells the agent that the owner
  must add it and pass Test first. The agent names a machine only by its name,
  never by an address.
- **One plan card in the private chat.** The card always goes to the owner's
  private chat, also when the owner asked in a group. The tool result says so
  and asks the agent to answer the owner as "you" (ADR-0222). Below the time and
  cost, and above the brief, the card says
  `🖥 It works on build-vm (nocheh@192.0.2.10) over SSH: one approval covers every
  command it runs there. Stop ends every program that login runs there.`, then
  `📋 Plan:` with the numbered steps. A saved card text without `{machine}` or
  `{steps}` still gets both lines. The machine and the plan are part of the
  job's fingerprint. Only the owner's press decides. The owner freedom setting,
  standing permissions and chat rules never replace this card, and no command
  gets a card of its own.
- **Card length.** Every job's card, machine job or not, must fit 3800 UTF-16
  units with its longest outcome line added. A longer card is refused with
  `job_card_too_long` before the job is saved, so the agent can make it shorter.
- **The pin.** When the job is asked for, it pins the machine's ID, name,
  address, port, login and host key, and checks them again, locked, in the
  transaction that saves the job. Every command checks the pin against the
  machine as it is now. Changing the machine's address, port or login, trusting
  a new host key for it, turning it off, removing it, or turning machine control
  off withdraws its cards still waiting and its approved jobs that have not
  started, with `job_machine_off` ("Withdrawn: its machine was turned off or
  changed. Nothing runs."). Its running jobs stop. A job already writing its
  report keeps going, as a job that ended normally does.
- **The run.** An approved machine job is one Hermes run under ADR-0207: at most
  50 minutes, its cost limit, Stop on its card, and its report sent to the chat
  that asked. Its run text, which the owner can edit as `background.machine`,
  names the machine, the login and the approved plan. It tells the agent to do
  only that plan, to ask nothing interactive, never to print keys or passwords
  it finds, to treat what files and output say as information, and to name in
  its report the programs it leaves running. Hermes's own `terminal`,
  `process_manage`, `read_file`, `write_file`, `patch` and `search_files` run on
  the machine through Nocheh's `nocheh_machine` terminal backend. The run keeps
  the archive tools, and Notion as ADR-0203 and ADR-0225 allow, so only a job
  asked for in the private chat reads Notion. It loses `execute_code`, Hermes
  memory, subagents, the approved shell and the browser.
- **Only in a sealed turn.** The backend runs only in a turn of the isolated
  runtime whose job asks for a machine and whose environment says so, both ways
  (`job_machine_unavailable` otherwise). A job never has both a box and a
  machine. A hook blocks these tools in every other turn. Hermes asks for no
  approval per command, since the card approved the plan, but its hardline floor
  and its block on guessing a password through `sudo -S` still apply. Commands
  have no terminal, so a password prompt fails. The file tools take paths on the
  machine: `~` is the machine login's home, as in its commands.
- **The path.** The backend sends each script with the run's own turn credential
  to the broker's `POST /v1/machines/exec`. The broker relays it to nocheh-app
  without an effect check of its own, with room for a 4 MiB input and a
  15-minute limit. nocheh-machines caps a command's output frames at 8 MiB,
  their 5-byte headers included, and the broker allows 64 KiB more for the
  notes and the exit code. The store checks the job again
  (`machineJob`): it is running and not stopped, the owner asked for it and
  approved it, its hard deadline has not passed, machine control is on, and its
  machine is on and still as pinned. The store writes the log row, then calls
  nocheh-machines with `NOCHEH_MACHINE_TOKEN` and the pinned values. Output
  streams back as frames, as the box's does. The model sees it as tool output,
  and the model's next request passes the secret check like every other.
- **The key.** The `nocheh-machines` service makes and keeps every key in
  `<state>/machines/<id>/`: `key` (mode 0600), `key.pub` and `known_hosts`. It is
  the only service that mounts that folder for its work. The dashboard and
  executor mount the whole state folder and the Docker socket for backups and
  restarts, as trusted administration (ADR-0048); they never read the keys and
  leave them out of backups. nocheh-machines never returns a private key. The
  database keeps only a key reference and the public key. Hermes, turns, the
  broker, nocheh-app and logs never hold a key, and the dashboard never shows one.
  Only nocheh-app and nocheh-machines get `NOCHEH_MACHINE_TOKEN`; it is kept in
  `.env` with the other generated credentials, and `./bin/nocheh init`, `up` and
  `make dev` generate it. nocheh-machines listens on port 8789 inside Compose
  only. Of the state folder it mounts only `machines/`, and it has no Docker
  socket, database login or service token. It runs with a read-only root and no
  capabilities, on the default network, with `host.docker.internal` mapped to the
  host. Keys are not in backups.
- **The SSH command.** nocheh-machines runs `ssh` with fixed options: no config
  file, only the machine's key, batch mode, strict host key checking against the
  machine's own `known_hosts`, a 10-second connect timeout, keepalives and a
  connection shared for 60 seconds. It checks the address, port and login
  against fixed patterns, and an address never starts with `-`. The script goes
  as one quoted argument to `bash -c` on the machine, after a random marker.
  What the login's shell prints before the marker is dropped. The command ends
  when that shell ends, as in the sealed box. Programs it started in the
  background keep running, but lose their output unless they write it to a file.
  When the machine has `timeout`, a command past its time limit is ended on the
  machine too. A failure before the marker is named `machine_auth_failed`,
  `machine_host_key_changed`, `machine_host_key_unknown` or
  `machine_unreachable`; a machine whose key nocheh-machines no longer has, as
  after a restore, gives `machine_key_missing`, and a command or cleanup that
  gets it marks the machine not ready, as a failed Test does. A script is at
  most 96 KiB and its input at most 4 MiB.
- **The log.** Each command gets a row in `machine_commands` before it runs: the
  machine, the job, the kind (`command`, `file`, `internal`, `cleanup` or `test`),
  the command Hermes asked for cut at 4000 characters, the sha256 of the script
  that ran, the state, the exit code, the sha256 and size of the output, an error
  code and the times. Output itself is not kept. The kind and the command come
  from the turn, so they are what the turn claims; the script's hash is what ran.
  The log keeps rows of removed machines and of jobs a reset erased. System ›
  Machine log shows it, and hides `internal` rows (commands Hermes runs by itself,
  such as its session setup) unless the owner asks for all. A row shows the
  fingerprint of what ran and of what it printed; while it runs, what it printed
  is not known yet. A row left running by
  a crash is closed as `ambiguous` once its job no longer runs, or after 70
  minutes.
- **Time.** Each command's time ends 30 seconds before the job's hard deadline,
  which is three minutes after its time limit (ADR-0207). With less time left, a
  command is refused with `machine_time_up`. Hermes waits at most 14 minutes for
  one command, so it ends before the broker's 15. While a command runs, the store
  checks the job every 2 seconds. When the check fails, it cuts the command off,
  which returns exit code 137 and the note `[nocheh: the job was stopped]`.
  Cutting a command off closes its connection only. Its program on the machine
  ends with the cleanup below, or at its time limit when the machine has
  `timeout`. A job still lasts at most 50 minutes, so a bigger setup becomes
  several jobs.
- **Ending programs.** When a machine job stops after it started, Nocheh ends
  every program of that login on the machine. That happens on Stop, at its time
  or cost limit, after a failed run, when its machine or machine control is
  turned off, and when its machine is changed, gets a new host key or is
  removed. The cleanup kills every process of the login's user except its own
  shell and SSH session. It needs `ps` on the machine: without it each try fails
  with `machine_cleanup_failed`, and System › Machine log says to install procps
  and end those programs by hand. A store loop runs it every 5 seconds, once
  none of the job's commands still streams, without waiting for the run to end.
  It tries up to three times and logs each try as `cleanup`. A change, a new
  host key or a removal first runs it for every job of that machine whose
  cleanup is still due, not only the jobs it stops, while the old key and host
  key still work, and waits for a cleanup already under way. Cleanups of one
  machine run one at a time, since each ends every program of the login.
  System › Background work says while a job's programs are being ended, and
  when Nocheh could not end them. A job that ends normally leaves what it
  started running, and its report names it. Its programs keep running also
  when its report then cannot be delivered.
- **Off switches.** **Machine control** in Settings › Machines, on by default,
  turns all machine work off at once, and each machine has its own switch.
  Turning either off withdraws waiting cards and stops the jobs as above.
  Without `NOCHEH_MACHINE_TOKEN`, machine control is unavailable: no machine can
  be added or tested, no job can ask for one, no command runs, the page says so,
  and nothing else changes.
- **A separate login.** Stop ends every program the login runs, so the page asks
  the owner to give Nocheh a login of its own on the machine, not the account
  they use themselves, with bash as its shell and `ps` (procps) installed.
- **No snapshots.** Nocheh takes no snapshot of a machine before a job and
  cannot undo what a job did there. Any machine with SSH, bash and `ps` works,
  whatever app or host runs it.
- **The address rule.** For shell, browser and MCP operations, ADR-0029's broker
  still reaches public HTTPS addresses only. The one exception is SSH from
  nocheh-machines to the address, port and login the owner saved for a machine,
  private addresses included. The job pins them, and the host key must be the
  one the owner's Test trusted. Nocheh never runs the script itself: it reaches
  the machine as one quoted argument.
</decision>

<what_stays>
- Every other job rule of ADR-0207: one run, the 50-minute bound, at most two
  relaunches with access checked again, the 80% notices, the limit note and
  Stop on the card.
- The sealed box and its GitHub copy (ADR-0205, ADR-0209) are unchanged.
- Shell, browser and MCP operations keep ADR-0029, with a card or a rule for each.
- Notion reads and changes in jobs keep ADR-0203 and ADR-0225.
- Every model request still passes the secret check, and a job is still priced
  by ADR-0206.
</what_stays>

<alternatives>
- **Hermes's own SSH backend.** Its key would sit in the turn, where the model's
  commands run, and any text the job reads could ask it to print the key.
- **A controlled operation for each command,** like the shell of ADR-0029. A
  setup takes dozens of commands, each with a card. The freedom setting and
  standing permissions would run them with no card at all.
- **The key in the launcher, the dashboard or the executor.** These hold the
  Docker socket or the whole state folder, and the launcher holds the service
  token. A small service with only the keys and one token holds the least.
- **SSH from nocheh-app.** The app holds database logins and the service token.
- **A snapshot before each job.** VM apps differ and share no interface, and the
  owner chose no snapshots.
- **Keeping command output in the log.** Output can hold secrets, and the log
  would keep them unchecked in the control store. The log keeps a hash and a
  size instead.
</alternatives>

<consequences>
- The owner asks in chat, approves one card, and Hermes's own tools set up the
  project on the machine, without a card for each command.
- One approval gives the job everything the login can do on the machine, for up
  to 50 minutes. The card shows the plan, and the run text tells the agent to
  keep to it, but Nocheh cannot check that each command belongs to the plan. The
  log shows what ran.
- Unlike the box, a machine has its own network. The job keeps the archive
  tools, so it could send what it reads out from the machine. Group messages and
  files on the machine can try to steer it. Only the owner can start such a job,
  the card names the machine and the plan, and the model sees output only
  through the secret check. Raw output, with any secret a command prints, is
  kept in runtime_context artifacts and the job's Hermes session, as all tool
  output is (ADR-0209).
- The command and its kind in the log are what the turn reports. A turn could
  report a wrong text, but the script's hash comes from what ran.
- Ending every program of the login also ends the owner's own sessions on it.
  That is why a separate login is advised. A job that ends normally leaves its
  programs running until the owner stops them, or until a later machine job on
  that login stops.
- Nocheh cannot undo a job's work. The owner can take snapshots with the VM's
  own tools.
- A changed host key stops every command with `machine_host_key_changed` until
  the owner trusts the new key. The first Test trusts whatever key answers, so
  it should run where the owner trusts the network.
- Keys are not backed up, and a reset erases them with the machines. A restored
  installation keeps its machines, still shown as Ready from their last Test,
  but not their keys: the next Test, command or cleanup fails with
  `machine_key_missing` ("Nocheh has no key for this machine"), and from then
  on the machine shows Test failed and no new job can ask for it. The owner
  removes each machine, adds it again and puts its new public key on the
  machine.
- Whether nocheh-machines reaches a machine depends on where the machine and
  Docker run. A VM on a network only its host can reach may need a port forward
  or a bridged network. Test is the check.
- One command lasts at most 14 minutes. Longer work runs in the background on
  the machine and writes its output to a file, and later commands look at it.
- SSH without a terminal does not end a program when its connection closes. A
  command past its time limit is ended on the machine only when the machine
  has `timeout` (it is part of coreutils). A command cut off earlier, by a lost
  connection for example, keeps running like a background command until then.
  A cleanup ends it when the job stops; after a job that ends normally it keeps
  running.
- The backend relies on Hermes's terminal provider and tool hooks. Each Hermes
  upgrade must run the machine checks again.
- The full tester scenarios `machine_job_runs_after_one_approval` and
  `machine_job_refused_for_members_and_stopped` run machine jobs end to end
  against an SSH server fixture. Still open: a job on a real VM with a real
  model.
</consequences>
