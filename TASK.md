# Nocheh implementation status

<about>

This page holds current status, open items and next steps only. [SPECS.md](SPECS.md) defines
the product, [ADRs](docs/adr/README.md) explain decisions, and [task history](docs/task-history.md)
summarizes finished work. The full dated log that this page held until 2026-11-22 is in
[Git history](https://github.com/PlaygrndLabs/nocheh/blob/7c07980160dd7ce0700a413b76375aa85bf0e685/TASK.md).
Live-test results are in [MVP acceptance status](docs/mvp-acceptance-status.md).

</about>

<current>

Nocheh is in development mode and not yet released. Everything below is built and merged on `main`.

- Parts: Hermes is the agent behind the agent socket ([ADR-0273](docs/adr/0273-the-brain-is-called-the-agent.md)); Honcho is long-term memory
  behind the memory socket; Nocheh's own `nocheh-telegram` service holds the bot; Inngest runs
  durable workflows; data tools reach the agent over Nocheh's MCP server.
- Chats: groups reply only when addressed and capture every message and file from everyone
  ([ADR-0264](docs/adr/0264-groups-are-read-whole-from-everyone.md)); held messages are all answered; reactions show progress.
- Members: owner-added members use their joined groups and their own private chat; in a group
  Nocheh answers from that group only; the mini app is English only (members steps 1 to 5,
  [ADR-0242](docs/adr/0242-private-chats-stay-out-of-group-sharing.md) to [ADR-0265](docs/adr/0265-member-mini-app.md)).
- Workspaces: several installs run side by side on one machine ([ADR-0245](docs/adr/0245-several-workspaces-on-one-machine.md)).
- Memory: fact sources and People pages ([ADR-0261](docs/adr/0261-recalled-facts-and-search-hits-name-their-source.md)); memory search stays on
  `text-embedding-3-small` until the owner picks another model ([ADR-0181](docs/adr/0181-memory-search-model-change-rebuilds-memory.md)); a group's recall, search and learning read
  through a memory wall that only holds its own chats ([ADR-0286](docs/adr/0286-memory-walls.md)); each project ticks which of its groups share memory ([ADR-0287](docs/adr/0287-projects-tick-the-groups-that-share-memory.md)).
- People: the name the owner sets in Memory › People is the person's name everywhere, and each
  person has a private note only the owner reads
  ([ADR-0274](docs/adr/0274-people-names-everywhere-and-private-notes.md)). Honcho 3.6.2 reads
  Nocheh's records by fixed reading instructions, and mentioned people keep no unread copies
  ([ADR-0275](docs/adr/0275-honcho-3-6-2-and-reading-instructions.md)). Memory thinking is priced as it
  runs and has an optional monthly dollar limit, off by default, in place of the request count
  ([ADR-0279](docs/adr/0279-memory-thinking-has-a-dollar-limit.md)).
- Assistant: a "what matters now" list and a morning brief through Hermes notes and its
  scheduler; a schedule approved once sends to the owner's private chat without a card.
  Members with "Personal assistant" on set their own schedules the same way in their private
  chat, up to the owner's cap, and each run reads only what that chat reads
  ([ADR-0277](docs/adr/0277-members-own-schedules.md)). A member's private chat reads, with no
  card, the Notion and GitHub of each project holding a group it reads
  ([ADR-0278](docs/adr/0278-member-private-chat-reads-project-connectors.md)). A member's new
  schedules run in their own time zone, set in the members' app or by asking
  ([ADR-0281](docs/adr/0281-members-own-time-zone.md)). The owner sets theirs on the Schedules
  page or by asking ([ADR-0282](docs/adr/0282-owners-time-zone-where-schedules-are.md)).
- Connections: a service connects to a project (shared) or a person (private). Notion per
  project or owner ([ADR-0268](docs/adr/0268-notion-per-project-or-person.md)), GitHub per project with live read-only lookups
  ([ADR-0269](docs/adr/0269-github-per-project.md), [ADR-0270](docs/adr/0270-github-live-lookups.md)), a Connections page ([ADR-0271](docs/adr/0271-connections-page.md)), the owner's Gmail read
  only ([ADR-0272](docs/adr/0272-gmail-read-only.md)). Each Notion sign-in shows its workspace and the signed-in
  account's name and email, from Notion's notion-get-self tool.
- Approvals: cards with scopes once, here and always this site; approved answers return to the
  asking chat ([ADR-0212](docs/adr/0212-approved-operations-answer-in-the-chat-that-asked.md), [ADR-0214](docs/adr/0214-allow-a-site-or-command-in-one-chat.md), [ADR-0215](docs/adr/0215-an-allowed-operation-answers-in-the-same-turn.md)); only addresses no model built open without a
  card ([ADR-0263](docs/adr/0263-only-addresses-no-model-built-open-without-a-card.md)).
- Security: the 2026-11 security review's fixes parts 1 to 5 are merged; machine jobs read only their
  card's chat, period and named Notion pages ([ADR-0283](docs/adr/0283-machine-jobs-read-only-their-card.md)), and
  watch start-up files and admin rights ([ADR-0284](docs/adr/0284-machine-jobs-watch-start-up-files-and-admin.md)); files are
  parsed by a separate reader with no network and no key ([ADR-0285](docs/adr/0285-files-are-parsed-by-a-separate-reader.md)).
  Per-person keys, step 1: the dashboard chat page is off and Hermes reads passes without the
  master key ([ADR-0289](docs/adr/0289-chat-page-off-and-hermes-reads-passes-without-the-master-key.md)); Nocheh
  grants every schedule change and fire, and Hermes's Cron page is read-only
  ([ADR-0290](docs/adr/0290-nocheh-grants-schedule-changes-and-fires.md)); an agent login replaces the master key in
  Hermes, which reaches only its own routes, and `rotate-keys` renews every key
  ([ADR-0291](docs/adr/0291-agent-login-replaces-the-master-key-in-hermes.md)). Next: one-time keys per reply.
- Dashboard: compact tables and sub-tabs on every page (table-first plan, steps 1 to 5);
  Connections, Members and Sent to apps pages.
- Operations: daily backups, export and import, an encrypted off-site copy (off until the owner
  turns it on), problem notices in the owner's private chat, and a Usage page.

</current>

<open>

Owner steps:
- Gmail setup is paused by the owner; offer it again later.
- One live check with a real member.
- Machine jobs: the owner's own Stop test on the connected VM.

Checks and follow-ups:
- Security fixes part 2 ([ADR-0251](docs/adr/0251-fixes-that-lose-nothing.md)): about a week after install, check `./bin/nocheh diagnose`
  for `hermes_page_script_reports` (none) and a passing tester run, then switch the Hermes page
  script policy from Report-Only to enforced in one commit. Later: one shared name cleaner for
  cards, forwards and recall labels, and a notice when an off-site restore check fails.
- Development startup order: a full tester run of `project_groups_stay_apart` alone.
- A project's tasks are one list ([ADR-0276](docs/adr/0276-a-projects-tasks-are-one-list.md)): a full tester run of
  `project_groups_stay_apart`, `member_private_chat_reads_joined_groups`, `member_app_tasks`,
  `member_app_drops_a_left_group` and `member_app_never_leaks`.
- Members' own schedules ([ADR-0277](docs/adr/0277-members-own-schedules.md)): a full tester run of
  `member_private_chat_reads_joined_groups` and `member_app_tasks`, then one live check with a
  real member setting a morning brief.
- Many entries in the old log end with "a live look on the owner's install after merge". These
  are not listed one by one; the old log in Git history has each one.
- Older October checks are also only in the old log: learning keeps valid items ([ADR-0128](docs/adr/0128-learning-results-keep-valid-items.md)),
  cut-off learning answers ([ADR-0140](docs/adr/0140-truncated-learning-results-keep-whole-items.md)), the scheduled-run simulator rerun, native reviews once
  per source ([ADR-0124](docs/adr/0124-native-review-once-per-source.md)) and during imports ([ADR-0173](docs/adr/0173-waiting-native-reviews-keep-their-place.md)), Honcho recall latency options
  ([ADR-0150](docs/adr/0150-honcho-recall-checks-take-reply-priority.md)), and Inngest storage growth. Many cover parts replaced since; confirm with the
  owner before redoing any.

Next:
- After go-live: members connect their own accounts, then Slack.
- After MVP: undo an import, Notion "Switch account", approval-card rule notes and "No, do this
  instead", Nocheh's own chat page (the dashboard chat page is off until then, [ADR-0289](docs/adr/0289-chat-page-off-and-hermes-reads-passes-without-the-master-key.md)).
- At go-live, production rules start: no data loss, data-keeping schema changes and tested
  upgrades.

</open>
