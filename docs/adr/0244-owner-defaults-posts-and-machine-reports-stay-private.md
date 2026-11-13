# ADR-0244: Owner defaults, group posts and machine reports stay private

<status>
Accepted on 2026-11-12 with the owner's Members design, as part of its step 1,
"Keep your private side out of groups". Amends the owner freedom setting as
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md) keeps it
(a private request no longer approves a message for a group), the one default
role and skills of
[ADR-0151](0151-chat-role-and-skills-in-hermes-profiles.md) and
[ADR-0196](0196-projects-have-their-own-role-and-skills.md) (one default for the
owner's private chat and one for groups), and the report destination of
[ADR-0231](0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md) and
[ADR-0207](0207-a-background-job-is-one-hermes-run.md) for machine jobs. Keeps
[ADR-0062](0062-owner-managed-telegram-group-participants.md) and
[ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md). Adds a
guard on the owner's Telegram user ID, and a canary gate in the full tester that
checks the step's rule end to end. Builds on the privacy canary of
[ADR-0241](0241-honcho-runs-only-the-tools-it-offered.md).
</status>

<context>
- The Members design sets the rule for this step: nothing crosses from the
  owner's private side to a group or a member's chat without a card in the
  owner's private chat that names who will see it. Anything that is not
  clearly a group or one of its topics counts as private.
- With the freedom setting at "Do what I ask", a request the owner made in
  their private chat approved itself, also for a message to a group. Text from
  the private side could reach a group with no card.
- `nocheh-default/` held one default role and skills for every chat. The role
  the owner wrote for their own chat loaded into every group turn, and the
  people in the group read the answers it shaped.
- A job on one of the owner's machines reported to the chat that asked. Asked
  in a group, its report, its limit note, its status with the machine, plan
  and to-do list, and the machine list itself showed there.
- Changing the owner's Telegram user ID moves the whole private side, with its
  approvals, Notion and machines, to another account. The dashboard changed it
  with one Save. `configure-telegram` wrote `.env` without the checks
  `config apply` runs, so an owner ID also listed as a person in a group was
  found only when the services refused to start.
</context>

<decision>
- **Group posts.** The freedom setting approves a request the owner makes in
  their live private chat only for tools and for a message to the owner's own
  private chat or one of its topics. A message for any group or topic always
  waits for its card in the private chat, which names that group and topic and
  shows the exact text, at both freedom levels. A follow-up turn never acts
  under the setting (ADR-0212), deny rules still win, and an allowed member's
  post to their own group stays as ADR-0159 has it.
- **Defaults per audience.** `nocheh-default/` is the default role and skills
  of the owner's private chat; `nocheh-default-groups/` is the default for
  groups. A turn takes the private chat's default only when its signed scope
  says it is the owner's private chat (`Scope.owner`); every other turn,
  including a group, a topic, a member's turn, a group's job and anything
  unclear, takes the default for groups. The default for groups starts empty:
  nothing is copied from the old shared default. A project's or a chat's role
  still replaces the default, and skills still stack. Settings › Assistant has
  one card for each (`default` and `default:groups`), each with its own
  revision.
- **Machine reports.** A job on one of the owner's machines sends its report,
  or its note at a limit, to the owner's private chat, also when the owner
  asked in a group. That group gets one fixed line from the owner-editable
  background texts (`report_private`, `limited_private`) that names no machine,
  plan or result. That line holds nothing the run read: once the whole report
  has reached the owner, a later change, a Stop or a line that cannot be
  delivered still ends the job done. A report that an earlier release had
  begun sending to the group keeps the parts already there; the owner then gets
  the whole report and the group its line. In a group, `start` returns no machine or steps, `status` lists no
  machines, and a machine job's status shows no machine, plan or to-do list,
  only that its plan and report are in the private chat. The plan card was
  already in the private chat (ADR-0231).
- **Owner ID guard.** Checking the settings refuses an owner ID that is listed
  as a person allowed or denied in a group, with a plain message; the services
  still refuse such a policy at start. The owner sets the ID the first time in
  Settings › Telegram, where Find my ID shows while no ID is saved. Once saved,
  the settings view marks it not editable (`changes_from: cli`) and a dashboard
  save that changes or clears it is refused. It changes only with
  `./bin/nocheh config set TELEGRAM_OWNER_ID <id>`, which runs the same checks.
  `configure-telegram` checks the whole policy before it writes `.env`.
- **Acceptance.** The full-tester scenario `owner_freedom_keeps_group_cards`
  replaces `owner_freedom_executes_owner_requests`: with the setting on, a post
  to a group waits for one card in the private chat that names the group, and
  nothing reaches the group before Approve; a message to the owner's own chat
  still goes without a card.
- **Canary gate.** ADR-0241's `private_chat_stays_out_of_groups` and its
  `PrivacyCanary` grow rather than gain a parallel scenario. The owner plants a
  new `PRIVATEMARK<n>` in their private chat in a plain message, a native note,
  a personal task, a private job left on its card, and their own default role,
  and the scenario finds each one there first (search, notes, task list, job
  status, the role in the turn's context). `OTHER_GROUP` joins a new active
  project with a task on its board, and a personal task's move onto that board
  waits for its card. Every question asked then in `GROUP`'s topic and in
  `OTHER_GROUP` carries a `PROBEMARK` and searches, recalls, lists tasks or
  reads job status; `private_text_in_group`, which counts any model request
  holding both marks, must not rise, and no group answer or tool result holds a
  private mark. The owner's notes review reads group messages into the owner's
  own notes, in the owner's profile and with the owner's role, so it is counted
  apart (`group_text_in_owner_review`). The cards are rejected, the role
  restored and the assignment removed at the end, also when a gate failed. The
  marks are saved to the fixture's `canaries.json`. The run's last scenario,
  `private_canaries_never_left_the_owner`, reads everything the fake Telegram
  holds and fails on any planted mark outside the owner's private chat: a
  message's text, entities, buttons or edits, the answer to a press by someone
  other than the owner, or a call Telegram refused; without saved marks it
  fails too. The sweep (`tools/acceptance/canaries.py` `leaks`) is a pure
  function of that state. What the fake has no stand-in for is unit-checked:
  a group turn's Notion result names no Notion page, and a mini app launch by
  a person listed in group access gets `owner_required` before anything is
  read or forwarded.
- **Project chats reach their list.** The canary's first run found that the
  security broker let only the owner's private turn reach `/v1/owner/tasks`,
  so a project's chat never had the list ADR-0164 and ADR-0243 give it. The
  broker now passes the task routes for a live turn, the owner's private one
  or a group's, and still refuses a job, a review and every other owner view;
  storage decides which list and shows a project's chat only its board view.
</decision>

<alternatives>
- Copying the old shared default into the default for groups would keep live
  groups as they are, but it would carry text the owner wrote for their own
  chat into groups without a card.
- Keeping machine jobs out of groups entirely would hide from the group that
  the job it asked for ended.
</alternatives>

<consequences>
- On a live installation, groups lose the role and skills set in the old
  shared default until the owner fills in the default for groups; the private
  chat keeps them. Group sessions that already hold answers shaped by that
  role are not cleared.
- With "Do what I ask", the owner still presses Approve for each post to a
  group.
- Built-in texts the owner already edited keep their old wording; only the
  defaults changed.
- A later owner ID change does not move or clear the private chat's Hermes
  profile or its memory. That is left to a later step of the Members design.
- The canary covers chat, notes, tasks, jobs, the role and what Telegram is
  sent; Notion and the mini app only through unit checks, since the full
  tester has no fake for them. A mark planted in a Notion page or on a
  machine is not checked end to end.
- Checks: group posts under freedom
  ([check](../../test/store-owner-autonomy.test.ts),
  [cards](../../test/store-approval-buttons.test.ts)); defaults per audience
  ([check](../../services/hermes/test_persona.py),
  [settings](../../services/hermes/test_management.py)); machine reports
  ([check](../../test/store-machine-group-report.test.ts),
  [cards](../../test/store-machines.test.ts)); the owner ID guard
  ([check](../../services/hermes/test_configuration.py),
  [services](../../test/assistant.test.ts),
  [bot](../../services/telegram/test_service.py)); the full-tester
  scenario in [telegram_scenarios.py](../../tools/acceptance/telegram_scenarios.py);
  and the canary gate ([scenarios](../../tools/acceptance/product_scenarios.py),
  [sweep](../../test/test_canary_sweep.py), [canary](../../test/test_scripted_brain.py),
  [Notion](../../test/store-notion.test.ts), [mini app](../../test/mini-app.test.ts),
  [task routes](../../test/knowledge-broker.test.ts)).
</consequences>
