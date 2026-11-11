# ADR-0235: Nocheh's own service is the Telegram bot

<status>
Accepted on 2026-11-11, after the owner said "yes start Telegram and brain
socket" for the build plan step that moves the front-door bots into Nocheh.
Builds on [ADR-0234](0234-brain-socket.md): every Telegram turn now returns its
reply, and the brain's `telegramReplies` option is gone. Keeps
[ADR-0133](0133-group-replies-when-addressed.md),
[ADR-0134](0134-editable-bot-names.md),
[ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md),
[ADR-0188](0188-typing-status-while-a-turn-works.md) and
[ADR-0211](0211-hermes-working-reactions-on-the-answered-message.md) as
behaviour; only who carries them out changes.
</status>

<context>
- Hermes held the bot token. Its Telegram adapter polled Telegram, decided
  whether a group message addressed the bot, showed typing and the working
  reaction, sent replies, approval cards, refusals and notices, ran approved
  sends and downloaded files.
- So swapping the brain would also have swapped the bot, and a brain could
  reach Telegram on its own. The owner's plan keeps data, rules and front
  doors in Nocheh and makes the brain one swappable part.
</context>

<decision>
- `services/telegram` is the `nocheh-telegram` service, the only process that
  holds the bot token. It polls Telegram into the capture spool, and on
  Nocheh's request shows presence, sends replies, approval cards, refusals and
  notices, runs approved sends, and reads files and chats. Every send is
  journaled before it leaves and bound to its chat, topic and current
  authority, as before. It shares the image with Hermes but never imports
  Hermes; shared file helpers are in `services/durable.py`.
- Its routes, all behind the service token on port 8784:
  `/internal/telegram/{identity,presence,reply,action,approval,refusal,notice,chat,file}`,
  and `/health` with the polling state. `src/frontdoor/telegram.ts` is the
  only code that knows them; `combinedAdapter` sends each `RuntimeCall`
  operation to the bot or to the Hermes helper services.
- Nocheh decides group addressing before any brain or presence
  (`src/telegram-addressing.ts`, with the bot's own username and display name
  from `identity`). An unaddressed group message closes `suppressed` with
  `not_addressed`; a refusal goes out only when the message addressed the bot.
- A turn: Nocheh shows typing and 👀 (`presence`), starts the brain turn,
  renews presence at each check (once a second; it lapses after 30 seconds
  without one), and when the brain is done asks the bot to send the reply,
  which leaves 👍. A failed turn leaves 👎; a cancelled, silent or lost one
  clears 👀. One id per turn attempt (`sha256(event_id:attempt)`) names the
  presence and the reply, and the bot keeps a receipt per reply, so asking
  again never sends twice.
- A reply waits, at most two minutes after its turn ended, while an earlier
  turn in the same chat still runs, so replies keep the order of their
  messages. A follow-up after approved operations alerts; an ordinary reply is
  silent. The owner's command replies need no brain and show no presence.
- Since the brain sends nothing, a turn the brain lost (`ambiguous`) runs
  again under a new attempt; only a send can end uncertain. A reply whose
  context changed while the brain worked is not sent and runs again
  (`space_policy_changed`), or is withdrawn when its source was retired or its
  chat deselected.
- `/v1/runtime` adds the bot's `telegram` state and `telegram_details` to the
  brain's status, so the dashboard reads them where it did.
</decision>

<consequences>
- Hermes is brain only: no token, no Telegram routes, and Telegram turns run
  only on `/internal/turn/*`. Another brain needs no Telegram code.
- The bot's settings (typing, reactions, group access, proxy) and its state
  folder `state/telegram` belong to `nocheh-telegram`; group reply mode and bot
  names belong to `nocheh-app`. Settings › Telegram looks the same.
- Hermes's own Telegram transport fallback (retrying through fixed addresses
  when DNS fails) is not ported; `TELEGRAM_PROXY` and the standard proxy
  variables still work.
- The dashboard container still reads the token for its own Bot API calls
  (Find my ID pre-check, group directory, mini app menu button). Moving those
  into the bot is follow-up work.
</consequences>
