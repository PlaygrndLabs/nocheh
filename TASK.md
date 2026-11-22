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
  `text-embedding-3-small` until the owner picks another model ([ADR-0181](docs/adr/0181-memory-search-model-change-rebuilds-memory.md)).
- People: the name the owner sets in Memory › People is the person's name everywhere, and each
  person has a private note only the owner reads
  ([ADR-0274](docs/adr/0274-people-names-everywhere-and-private-notes.md)). Honcho 3.6.2 reads
  Nocheh's records by fixed reading instructions, and mentioned people keep no unread copies
  ([ADR-0275](docs/adr/0275-honcho-3-6-2-and-reading-instructions.md)).
- Assistant: a "what matters now" list and a morning brief through Hermes notes and its
  scheduler; a schedule approved once sends to the owner's private chat without a card.
- Connections: a service connects to a project (shared) or a person (private). Notion per
  project or owner ([ADR-0268](docs/adr/0268-notion-per-project-or-person.md)), GitHub per project with live read-only lookups
  ([ADR-0269](docs/adr/0269-github-per-project.md), [ADR-0270](docs/adr/0270-github-live-lookups.md)), a Connections page ([ADR-0271](docs/adr/0271-connections-page.md)), the owner's Gmail read
  only ([ADR-0272](docs/adr/0272-gmail-read-only.md)).
- Approvals: cards with scopes once, here and always this site; approved answers return to the
  asking chat ([ADR-0212](docs/adr/0212-approved-operations-answer-in-the-chat-that-asked.md), [ADR-0214](docs/adr/0214-allow-a-site-or-command-in-one-chat.md), [ADR-0215](docs/adr/0215-an-allowed-operation-answers-in-the-same-turn.md)); only addresses no model built open without a
  card ([ADR-0263](docs/adr/0263-only-addresses-no-model-built-open-without-a-card.md)).
- Security: the 2026-11 security review's fixes parts 1 to 5 are merged; the machine-jobs fix and a
  separate file reader are still to build ([ADR-0250](docs/adr/0250-cards-and-forwards-say-whose-words-they-are.md) to [ADR-0263](docs/adr/0263-only-addresses-no-model-built-open-without-a-card.md)).
- Dashboard: compact tables and sub-tabs on every page (table-first plan, steps 1 to 5);
  Connections, Members and Sent to apps pages.
- Operations: daily backups, export and import, an encrypted off-site copy (off until the owner
  turns it on), problem notices in the owner's private chat, and a Usage page.

</current>

<open>

Owner steps:
- Reconnect the owner's own Notion once in Connections › Yours.
- Gmail setup is paused by the owner; offer it again later.
- One live check with a real member.
- Machine jobs: the owner's own Stop test on the connected VM.

Checks and follow-ups:
- Security fixes part 2 ([ADR-0251](docs/adr/0251-fixes-that-lose-nothing.md)): about a week after install, check `./bin/nocheh diagnose`
  for `hermes_page_script_reports` (none) and a passing tester run, then switch the Hermes page
  script policy from Report-Only to enforced in one commit. Later: one shared name cleaner for
  cards, forwards and recall labels, and a notice when an off-site restore check fails.
- Development startup order: a full tester run of `project_groups_stay_apart` alone.
- Many entries in the old log end with "a live look on the owner's install after merge". These
  are not listed one by one; the old log in Git history has each one.
- Older October checks are also only in the old log: learning keeps valid items ([ADR-0128](docs/adr/0128-learning-results-keep-valid-items.md)),
  cut-off learning answers ([ADR-0140](docs/adr/0140-truncated-learning-results-keep-whole-items.md)), the scheduled-run simulator rerun, native reviews once
  per source ([ADR-0124](docs/adr/0124-native-review-once-per-source.md)) and during imports ([ADR-0173](docs/adr/0173-waiting-native-reviews-keep-their-place.md)), Honcho recall latency options
  ([ADR-0150](docs/adr/0150-honcho-recall-checks-take-reply-priority.md)), and Inngest storage growth. Many cover parts replaced since; confirm with the
  owner before redoing any.

Next:
- Security review: the machine-jobs fix, then a separate file reader.
- After go-live: members connect their own accounts, then Slack.
- After MVP: undo an import, Notion "Switch account", approval-card rule notes and "No, do this
  instead", Nocheh's own chat page in place of the temporary Hermes chat link.
- At go-live, production rules start: no data loss, data-keeping schema changes and tested
  upgrades.

</open>
