# ADR-0284: Machine jobs watch start-up files and say when the login is admin

<status>
Accepted on 2026-11-23. The owner approved this fix in the November security review: stay on
the owner's own login, say on every card when it can act as admin, check the login's start-up
files and tools after each job in a way a planted program can't fake, and tell the owner when
Stop fails. Amends [ADR-0231](0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md)
(the card and the test) and [ADR-0237](0237-stop-ends-only-the-programs-a-machine-job-started.md)
(what Stop can promise).
</status>

<context>
- A job runs as the owner's login. It can add a line to `~/.zshenv`, a launch agent or an SSH
  key, or replace Homebrew's `bash` or `gtimeout`. Such a change outlives Stop, and every later
  command runs through it.
- Anything Nocheh asks through the login's shell runs those files first, so a planted line could
  answer a check for them. sshd's `Subsystem sftp internal-sftp` answers SFTP inside sshd: no
  program of the login runs.
- A login with password-free `sudo` lets any step act as admin, whatever the plan says. Programs
  started with `sudo` are root's, and Stop does not end them.
</context>

<decision>
1. **`/probe` in nocheh-machines.** It asks `sudo -n true` through the login's shell (admin or
   not), then reads over SFTP, with its own SFTP client and a new connection, the digests of the
   login's shell start-up files, `~/.ssh/authorized_keys`, `rc` and `environment`, the bash and
   timeout programs the wrapper runs, the listings of `~/Library/LaunchAgents`,
   `~/.config/systemd/user`, `~/.config/autostart` (with each file's bytes) and of Homebrew's
   `bin` folders. Without SFTP it says `machine_files_unavailable`; then nothing is compared.
2. **Admin on the card.** A passing Test stores `machines.admin`; a machine is ready only with
   it known. The pin carries it, so it is part of what is approved, and the card adds
   "🔑 It can also act as admin there: any step can use it." Before a job's first command the
   probe runs again; when the login's admin rights differ from the card, nothing runs, the job
   stops (`job_machine_admin_changed`, its card says why) and the machine needs a new Test
   (`machine_admin_changed`).
3. **Start-up files.** The first probe of a job keeps its digests (`machine_files`). Once the job
   has ended and its programs were ended, the store probes again and keeps which labels differ
   (`machine_check`: same, changed or unchecked). The job's settled card adds one line: the same,
   what changed (at most five places, then how many more), or that it could not be checked. The
   machine keeps the result (`machines.changed`), and every new card for it warns
   ("⚠️ The last job on … changed …" or "couldn't check …") until a job changes nothing or a
   Test passes.
4. **Stop that failed.** The owner's problem notice counts stopped machine jobs whose programs
   could not be ended in the last 7 days (`machine_cleanup`, read from `GET /v1/machines`);
   each new one is news.
5. **Honest wording.** The card and ADR-0237 say Stop does not end programs started with `sudo`,
   `open` or `brew services`. A cleanup that reports success means the machine reported its
   programs ended; after a job changed start-up files or tools, that report can't be trusted.
6. **The VM setting.** The setup guide and the machine page ask for `Subsystem sftp
   internal-sftp` in `sshd_config`.
</decision>

<consequences>
- The owner keeps their own login, Homebrew and tools. One line on the card tells them when a
  job can act as admin.
- A job that plants something in the watched places is named on its own card and on the next
  card for that machine. A job that plants elsewhere, or changes what it plants back before it
  ends, is not seen.
- Without `internal-sftp`, a planted line in the login's shell files could answer the SFTP read;
  the check is only as strong as that setting.
- `sudo -n true` is asked through the login's shell, so a planted line can hide admin rights at
  a Test. The start check then sees the same answer; the start-up files line is what shows the
  plant.
- Machines tested before this change need one new Test before a job can ask for them.
- Checks: `services/hermes/test_machine_server.py` (real `sftp-server`),
  `test/store-machines.test.ts`, `services/hermes/test_problem_notices.py`.
</consequences>
