# ADR-0238: Record every send to a chat app

<status>
Accepted on 2026-11-11, after the owner said "I think we should record every
agent that send to apps like telegram, slack, etc" and answered "yes" to the
plan: record everything Nocheh sends to any chat app, including messages,
edits, cards and reactions; show what was sent, to which chat, when, and
whether it worked; the dashboard shows the failed ones; skip "typing…", which
fires constantly. Asked whether a "typing…" that fails should still be
recorded, the owner chose "Never record typing" on 2026-11-12.
Builds on [ADR-0235](0235-nocheh-owns-the-telegram-bot.md). Amends the "no
stored record" of
[ADR-0211](0211-hermes-working-reactions-on-the-answered-message.md);
[ADR-0188](0188-typing-status-while-a-turn-works.md)'s "typing…" still leaves
none.
</status>

<context>
- Since ADR-0235, every Bot API request of `nocheh-telegram` passes one
  wrapped request (`services/telegram/capture.py`). It journals every request
  except reads, chat actions and working reactions: a write-once intent before
  the request leaves and a result after, in `spool/outbound`, also handed to
  the store as `outbound_intent` and `outbound_result` events. The journal
  keeps the full parameters (text, buttons, callback data) and Telegram's whole
  answer. So replies, cards and notices were recorded, but with their content,
  as evidence for deliveries and reply links, and nothing showed them to the
  owner as a list of sends.
- Working reactions and "typing…" skip the journal (ADR-0188, ADR-0211) and
  left no stored record; the gateway swallowed their failures as cosmetic.
  ADR-0211 says a failed reaction "is logged by the native hook". That hook
  stopped running with ADR-0235, and `nocheh-telegram` turns Python logging off
  and sends its output to `/dev/null` so the token cannot leak, so a failed
  reaction was not even logged.
- Other outcomes left no trace either: a request the outbound check refused
  before it left, a reply the sender's flood window held back, card edits and
  button answers whose failure the gateway reports only as not done, and card,
  refusal and notice failures reported as `ambiguous` even when Telegram gave a
  definite refusal. Nothing about sends reached System › Health or the owner's
  problem notices.
- Telegram is one front door; Slack or another app may follow, and the owner
  asked for every app.
</context>

<decision>
- One record per physical request a front door sends to a chat app, written as
  one write-once file `spool/sends/<sha256(key)>.json` in canonical JSON
  (`services/durable.py`, `services/telegram/sends.py`). Its closed fields:
  `version` (1), `key` (`send:<channel>:<account>:<32 hex>`, new for every
  attempt), `channel` (`telegram`), `account` (the bot ID), `at` (UTC with
  milliseconds, when the request ended or was refused), `kind`, `method` (the
  platform's API method), `chat`, `topic`, `message_id` (the new message's ID
  from the answer, or the message an edit or reaction targets), `detail` (only
  a reaction's emoji, or `clear`), `state`, `status` (HTTP, 0 when none),
  `error_code`, `reference` (the content-free dispatch key it ran under; none
  for setup and reactions) and `ms`. A record never holds message or
  button text, callback data, URLs, the token, exception text or the
  platform's error description: only codes and IDs.
- Kinds (closed): `reply`, `approved_send`, `approval_card`, `card_update`,
  `button_answer`, `refusal`, `notice`, `notice_update`, `reaction`, `setup`,
  `other`. Telegram takes `reaction` from the method (`setMessageReaction`) and
  the rest from the dispatch key's prefix; a request with no key or a `control:` key (`deleteWebhook`,
  `deleteMyCommands`) is `setup`.
- States (closed): `sent` (the app took it: 2xx and `ok`); `failed` (the app
  definitely refused it: 4xx, or 2xx without `ok`); `uncertain` (no answer, a
  timeout, a network error, a 5xx, or a restart cut it off: it may have
  arrived); `not_sent` (Nocheh did not let it out). A Telegram refusal's code
  comes from its description, first match wins (`bot_blocked`,
  `user_deactivated`, `bot_removed`, `chat_not_found`, `topic_not_found`,
  `message_not_found`, `message_not_modified`, `formatting_rejected`,
  `button_answer_expired`, `reaction_not_allowed`, `no_permission`,
  `message_too_long`, `button_rejected`), then from its status
  (`rate_limited`, `unauthorized`, `forbidden`, `conflict`, else `rejected`).
  An uncertain one is `timed_out`, `network_error`, `server_error` or
  `restart`. A not-sent one carries the check's own code (`audience_changed`,
  `cancelled`, `authority_revoked`, `reaction_unbound`),
  `rate_limited` for the flood window, or `refused`.
- What Telegram records: every request of the service bot that is not a read
  (`get…` methods and file downloads never are) and that left, with its
  outcome, reactions included; every request Nocheh's own check refused; and
  one `sendMessage` record for each reply or approved send the sender's flood
  window (armed after Telegram asked it to wait) held back whole. A journal
  replay sends nothing and a hold after an uncertain attempt follows that
  attempt's record, so neither adds one. "typing…" (`sendChatAction`) is
  never recorded, whether it was sent, failed or held: it fires every few
  seconds, and the owner chose not to record it even when it fails.
- A record is a log for the owner, never evidence or authority. It is not
  journaled, not an archive event, not a delivery receipt and not a capture
  receipt, and nothing reads it to decide whether to send or send again.
  Writing it never fails, blocks or slows the send: it is written off the event
  loop, every error is dropped, and shutdown waits at most five seconds for
  records still being written.
- `nocheh-app`'s storage worker drains `spool/sends` in its own `sends` stage,
  at most 500 files a pass, so an outage there never holds up source capture.
  Each file is checked against the closed shape; one that can never become
  valid is removed. Valid ones go into `control.chat_sends`
  (`ON CONFLICT (record_key) DO NOTHING`) and only then are their files
  removed; a database outage leaves them for the next pass. The owner's "Keep
  delivery logs" days (`NOCHEH_HERMES_JOURNAL_RETENTION_DAYS`, `0` keeps every
  record, the default) also delete rows older than that by `at`, checked
  hourly in bounded batches.
- Storage `/v1/status` carries `chat_sends`: the last 24 hours' counts by
  state, `problems` (failed and uncertain, without the expected no-ops
  `message_not_modified`, `button_answer_expired` and `reaction_not_allowed`,
  and without a recovered try: one followed within 15 minutes by a `sent`
  record with the same channel, chat, method and reference, a `:retry:N`
  suffix ignored), `problem_kinds`,
  `last_problem_at` (any age) and the ten latest problems. The owner reads all
  records at `GET /v1/chat-sends` (`filter=all|problems`, `kind`, `before`,
  `limit` up to 100), newest first, with the chat's saved title where Nocheh
  knows it and whether each record counts as a problem or recovered, through
  the owner storage allowlist.
- The dashboard shows them as System › Sent to apps, with an All and a
  Problems filter, and System › Health (with the mini app's Health) lists
  "N sends to chat apps failed in the last day", linking there. The owner's
  problem notices gain the kind `sends` with the same line and the other kinds'
  rules: at most hourly and only when worse, marked fixed when the count is
  back to zero, and a summary that could not be read is not zero. It counts the
  same problems without kinds `notice` and `notice_update`, so a notice that
  cannot be sent never asks for another. Because the count covers a rolling
  day, a fall from failures aging out is not a fix: the highest count told
  stays the bar until the count reaches zero, so the same failures aging out
  and new ones arriving are not news again.
- The record is platform neutral: it names its channel and account, and each
  platform has its own chat ID form (Telegram's numeric IDs; others letters,
  digits, `_` and `-`). A Slack front door, or any later one, writes the same
  file into the same spool from its own request boundary; storage, the views
  and the notices stay as they are.
</decision>

<consequences>
- ADR-0211 no longer costs "no stored record": each working reaction leaves
  one send record. It stays outside the journal, is not a delivery and never
  enters the archive; a retried turn still sets its 👀 again. "typing…"
  (ADR-0188) still leaves no record. ADR-0211's "logged by the native hook"
  is replaced by the record: a refused reaction shows as `failed` with
  `reaction_not_allowed` or another code.
- A reply split into chunks, sent again as plain text or retried after a rate
  limit leaves one record per request, so the list shows attempts, not
  messages; a try that a later one recovered is marked "sent on a retry" and
  is not a problem. A request a restart cut off is recorded when the service starts
  again, at that time, with `restart`.
- Records hold chat and message IDs but no content, and are kept forever by
  default, like the delivery logs; a turn adds a few rows.
- System › Health counts a failed notice; the notices themselves do not.
- Known gaps. The dashboard container still calls the Bot API itself with the
  token (ADR-0235): `setChatMenuButton`, the mini app's menu button set on
  every settings apply, is a send that leaves no record until it moves into
  `nocheh-telegram`, as ADR-0235 plans; the group directory's chat and member
  reads and the Find my ID check are reads, which stay unrecorded there too.
  The separate bot that serves the file and chat reads is not wrapped, and it
  only reads.
</consequences>
