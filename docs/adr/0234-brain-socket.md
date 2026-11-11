# ADR-0234: The brain sits behind a brain socket

<status>
Accepted on 2026-11-11, after the owner said "yes start Telegram and brain
socket" for the build plan step that makes the brain swappable while the data,
rules and front doors stay in Nocheh. Builds on
[ADR-0232](0232-memory-engine-socket.md)'s memory socket and
[ADR-0233](0233-data-tools-over-mcp.md)'s data tools, keeps
[ADR-0152](0152-owner-editable-built-in-instructions.md)'s owner instruction
texts, and replaces the brain half of the runtime operation list behind
`RuntimeCall`.
</status>

<context>
- Nocheh reached Hermes through one runtime operation list. Turns
  (`run.start`, `run.resume`, `run.cancel`, `run.events`), Hermes's own
  settings, persona, notes, notes review and scheduled tasks sat in the same
  list as helper services that Hermes happens to host today: the secret check,
  file, voice and image reading, prices, the memory filter and the Telegram
  calls.
- Swapping Hermes for another agent, such as Claude Code, meant editing every
  caller of that list, and nothing said which operations a brain must offer.
- The owner wants the brain and the memory swappable, one brain at a time,
  while Nocheh keeps messages, people and chats, sharing rules, approvals,
  long-term memory and the platform bots. Hermes's internals do not change.
</context>

<decision>
- `src/brain/brain.ts` defines `Brain`, the brain socket. Words: a turn is
  one run of the brain for one message, follow-up, dashboard chat message,
  scheduled task or background job; a ref is the turn's identity (channel,
  event and attempt); a receipt is what the brain reports about a turn and
  keeps, so a lost answer can be asked for again; a reply is the text a turn
  answers with.
- Every brain offers turns: `startTurn`, `observeTurn`, `cancelTurn` and
  `turnEvents`, each safe to repeat because one ref runs at most once, plus
  `status`, and names its `channels` (`telegram`, `browser`, `scheduler`,
  `background`). A brain may also offer its own state: `readSettings`,
  `writeSettings`, `readPersona`, `writePersona`, `promptDefaults`,
  `listProfiles`, `readNotes`, `recallNotes`, `reviewNotes` and
  `advanceSchedules`. A missing one, or a channel the brain does not run,
  answers `brain_capability_unavailable`.
- The brain never sends anything to a platform. A Telegram turn either returns
  its reply in the receipt for Nocheh's own bot to send, or ends `suppressed`
  with `intentional_silence`. Hermes's turn routes `/internal/turn/*` return
  the reply, and Nocheh's own bot sends it
  ([ADR-0235](0235-nocheh-owns-the-telegram-bot.md)).
- Every brain reports failures with the same codes: `brain_unavailable` (no
  answer, a started turn may exist), `brain_rejected` (an error answer, nothing
  started or changed), `brain_invalid_response` and
  `brain_capability_unavailable`. `quota_paused`, `provider_not_configured`
  and owner-actionable settings refusals keep their own codes.
- `src/brain/hermes.ts` is the only code that knows Hermes's run, management
  and notes routes. `src/brain/brains.ts` is the one place that chooses the
  brain; Hermes is the only brain today, and turn passes name it.
- `RuntimeCall` keeps only the helper services and the Telegram calls, which
  Nocheh's own bot answers since ADR-0235. The owner's instruction texts ride on turns and notes reviews
  through the socket, and on the helper services that run one.
- The owner API's brain route is `/v1/brain/manage` and its admin operation
  `brain.manage`. `/v1/runtime` reports `brain` with its id, name and
  capabilities, the brain's `status`, and the helper services' capabilities.
  Health shows "Brain: Hermes" on the assistant row and lists what the brain
  can do.
- Stored names stay as they are, because renaming them would break a running
  installation: result protocols such as `hermes-native-review-v3`, the
  `hermes_*` stage timings and the `hermes` usage source. Brain-run results
  name the brain that produced them.
</decision>

<consequences>
- A new brain is one file that implements `Brain`, plus one line in
  `brains.ts`. A brain without settings, persona, notes or instruction
  defaults leaves those operations out. The dashboard pages that read them
  (per-chat limits, role and skills, notes, built-in instructions) then say
  "The connected assistant can't do this" instead of offering a retry.
- Nocheh's own chat interface can later talk to whichever brain is connected
  through `startTurn` and `observeTurn`.
- The helper services still run in the Hermes service. The Telegram calls
  moved out of it with ADR-0235.
</consequences>
