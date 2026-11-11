# ADR-0237: Stop ends only the programs a machine job started

<status>
Accepted on 2026-11-11, after the owner asked for Nocheh to work as the login they
use themselves on their machine, while they keep working there at the same time.
Amends [ADR-0231](0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md):
its "Ending programs" and "A separate login" rules change as below; everything
else stays.
</status>

<context>
- ADR-0231's cleanup ended every process of the job's login. On a login the owner
  uses, Stop, a limit or a failed run would also end the owner's own programs and,
  on a desktop, their whole session, so ADR-0231 asked for a login of Nocheh's own.
- The owner wants Nocheh on their own login, so that it can use what that login
  has, and to keep working there while a job runs.
- A process inherits its parent's environment. Linux shows each process's
  environment in `/proc/<pid>/environ`; macOS and the BSDs show it with `ps -E`.
- macOS ships bash 3.2 and no `timeout`; Homebrew's coreutils names it `gtimeout`.
</context>

<decision>
- **A tag on every command.** `nocheh-machines` runs each command of a job with
  `NOCHEH_STARTED=<the job's id>` in its environment, so every program the
  command starts carries it too, also one in a new session or in the background.
  The store sends the job's id with each command and each cleanup.
- **The cleanup ends only tagged programs.** It ends the login's processes whose
  environment has the job's tag, in up to five rounds for programs started
  meanwhile, and nothing else: not the owner's own programs, and not what other
  jobs left running. It reads environments from `/proc` where it has them (Linux,
  busybox too), and otherwise from `ps -E` one process at a time (macOS, BSD),
  as words, since a command line may span lines.
- **It proves it can see a tag first.** The cleanup's shell runs with
  `NOCHEH_CLEANUP=<its own PID>`, a value its own text never spells out, and must
  find that in its own environment before it ends anything. Where it cannot, or
  where tagged programs are still there after five rounds, the cleanup fails
  with `machine_cleanup_failed`, as before, rather than claim it ended them.
- **Any login.** The owner may give Nocheh the login they use themselves. The
  machine needs bash; bash 4 or later and coreutils' `timeout` work best, and
  the wrapper also takes `gtimeout`. Procps is no longer needed.
- When the rules apply, the off switches, the log, the tries and the order of
  cleanups stay as in ADR-0231. The cleanup's log line says "end the programs this
  job started as <login>".
- The job's instructions say that the login may be the owner's own and that it
  must not stop or change the owner's programs unless the plan says so.
</decision>

<consequences>
- Stop, a limit or a failed run leaves the owner's own programs and their desktop
  session alone, and also leaves what earlier jobs left running.
- A program the system starts for a job has no tag and keeps running after Stop:
  an app opened with `open`, a service started with `brew services`, `launchctl`
  or `systemctl`, a container started through a container engine, or a program
  that clears its environment. The job's instructions name these, and its report
  names what it left running.
- Commands a job asked for through the owner's own running programs, such as a
  terminal multiplexer the owner started, run untagged inside them.
- On macOS, a command past its time limit ends on the machine only when bash 4 or
  later and `timeout` or `gtimeout` are on the login's PATH for SSH commands, for
  example from `~/.zshenv`. Without them it runs as ADR-0231 describes for such
  machines.
- On macOS, SSH sessions cannot read Desktop, Documents or Downloads unless the
  owner allows full disk access for remote users in Remote Login's settings.
</consequences>
