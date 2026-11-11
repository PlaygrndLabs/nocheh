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
- A process inherits its parent's environment and open files. Linux shows both in
  `/proc`. macOS shows open files with `lsof` and environments with `ps -E`, but
  with System Integrity Protection on (the default) it shows no environment for the
  system's own programs, such as `sleep` or `bash` in `/bin`.
- No single trace survives every program: a program may close the files it
  inherited, write a new name over its environment (redis does, and so do Perl and
  Node programs that rename themselves), or keep its environment from being read
  (an ssh-agent on Linux). A daemon leaves its parent.
- macOS ships bash 3.2 and no `timeout`; Homebrew's coreutils names it `gtimeout`.
</context>

<decision>
- **Two traces on every command.** `nocheh-machines` runs each command of a job
  with `NOCHEH_STARTED=<the job's id>` in its environment, and the wrapper opens
  the job's marker file, `~/.nocheh/jobs/<the job's id>`, as fd 7 before the
  script starts. Every program the command starts inherits both, also one in a
  new session or in the background. Marker files older than 30 days are removed.
  The store sends the job's id with each command and each cleanup.
- **The cleanup ends only the job's programs.** A process of the login is the
  job's when it holds the job's marker open, carries its tag, or was started by a
  process that does. The cleanup ends those, in up to five rounds for programs
  started meanwhile, and nothing else: not the owner's own programs, and not what
  other jobs left running. On Linux it reads `/proc`; on macOS it asks `lsof` for
  the marker's holders, `ps -E` for tags (checking each process that shows one on
  its own, since a command line may span lines) and `ps` for who started whom.
  It removes the marker once nothing of the job is left.
- **It proves it can find a program first.** Before it ends anything, the cleanup
  starts a `sleep` that holds a probe file open and must find it by that file, a
  system program on macOS. Where it cannot, or where the job's programs are still
  there after five rounds, the cleanup fails with `machine_cleanup_failed`, as
  before, rather than claim it ended them. Its text never spells out a tag it
  looks for, so it never finds itself.
- **Any login.** The owner may give Nocheh the login they use themselves. The
  machine needs bash (3.2 runs the cleanup too); bash 4 or later and coreutils'
  `timeout` work best, and the wrapper also takes `gtimeout`. Procps is no longer
  needed. The cleanup runs as `bash -c`, so the login's own shell only parses
  quoted words, also a fish shell.
- When the rules apply, the off switches, the log, the tries and the order of
  cleanups stay as in ADR-0231. The cleanup's log line says "end the programs this
  job started as <login>", and it gets 60 seconds.
- The job's instructions say that the login may be the owner's own, that it must
  not stop or change the owner's programs unless the plan says so, and that Stop
  also ends a shared server the job starts, such as tmux, with everything in it.
</decision>

<consequences>
- Stop, a limit or a failed run leaves the owner's own programs and their desktop
  session alone, and also leaves what earlier jobs left running.
- A program the system starts for a job has neither trace and keeps running after
  Stop: an app opened with `open`, a service started with `brew services`,
  `launchctl` or `systemctl`, or a container started through a container engine.
  So does a program that loses both traces and its parent: one that closes what it
  inherited, hides or overwrites its environment and leaves its parent, such as an
  ssh-agent on Linux, or a system program on macOS started by a program that
  closes inherited files and then ends. The job's instructions name the first kind,
  and its report names what it left running.
- A shared server the job starts, such as tmux or an `emacs --daemon`, ends on Stop
  with everything running inside it, also what the owner started there.
- Commands a job asked for through the owner's own running programs, such as a
  terminal multiplexer the owner started, run without the job's traces inside them.
- On macOS, a command past its time limit ends on the machine only when bash 4 or
  later and `timeout` or `gtimeout` are on the login's PATH for SSH commands, for
  example from `~/.zshenv`. Without them it runs as ADR-0231 describes for such
  machines. Without `/proc`, the wrapper's output copy gets 0.3 seconds after the
  script ends, so a very slow reader can miss the end of a large output.
- On macOS, SSH sessions cannot read Desktop, Documents or Downloads unless the
  owner allows full disk access for remote users in Remote Login's settings.
- The login's home gets a `.nocheh/jobs` folder with one empty file per job.
</consequences>
