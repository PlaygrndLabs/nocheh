# ADR-0217: An unclear outcome closes by the owner's word, or by itself for a page read

<status>
Accepted on 2026-11-08 after the owner's Inbox kept two web page reads marked
"Unclear if it ran" in Waiting, one of them from the day before, with no way to
clear them. Extends
[ADR-0029](0029-controlled-tool-execution.md),
[ADR-0091](0091-bounded-agent-knowledge-organization.md),
[ADR-0202](0202-approved-actions-report-how-they-ended.md) and
[ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md).
</status>

<context>
An approved operation or Telegram message whose outcome no receipt confirms
ends as `ambiguous`. ADR-0029 keeps such an effect uncertain and never repeats
it. Waiting lists every uncertain operation and message, with no age limit, and
nothing could close one: decisions accept only waiting or approved actions, and
the drawer offered no control for this state. System › Health and the problem
notices kept counting the same items as uncertain tasks.

Most such items were web page reads. A read is one plain GET of a public page
that renders offline. Whether or not its answer came back, it changes nothing
that Nocheh could need to reconcile.

The receipt cannot simply be rewritten. Receipt recovery compares the stored
state with the executor's saved receipt and refuses a mismatch, and the
executor sends every saved receipt again before it claims new work, so one
refused receipt would stop all later tool runs. An owner's word is also not an
observed result (SPECS: an allow decision is not a receipt).
</context>

<decision>

- An unclear operation or message keeps its state and receipt as observed. How
  it was closed is a separate `resolution` with its time:
  - `read_closed`: a web page read closes itself in the same commit that makes
    it unclear, whether the executor's receipt was unconfirmed or its lease ran
    out without one. Reads that ended unclear before this rule are closed once
    by the schema.
  - `ran`, `not_run` or `dismissed`: the owner's word, from the action's drawer
    (It ran / It didn't run / Dismiss; for a message, It was sent / It wasn't
    sent / Dismiss). It goes through the owner command records with the exact
    fingerprint and revision, like a decision, and only an unclear, unclosed
    action takes it.
- A closed action leaves Waiting and the Telegram `/actions` list, and the
  Messages page shows a closed send as closed, not uncertain. Its task
  counts as done when the owner said it ran and as skipped otherwise, so Health
  and the problem notices stop counting it as uncertain. Its card is edited to
  say how it closed: the page did not answer, or the owner's word. A read that
  never started still says it did not run, and a dismissed one keeps the
  uncertain line. A job's list card counts an operation the owner said ran as
  done.
- The owner's word runs, sends and retries nothing. An unclear message stops
  being checked once closed; a delivery receipt saved before the owner's word
  still settles it. A later executor receipt is an observed result: it settles
  the operation as before, and the resolution then no longer shows.
- A check of an unclear message that finds the same outcome no longer raises
  its revision, so an open review of it stays usable.
- The agent's action status shows the resolution.

</decision>

<consequences>

- Waiting holds only items that need the owner. History keeps closed items and
  says how each one closed.
- An unclear shell command, MCP call or message still needs the owner's word; a
  read never does.
- The two existing reads leave Waiting once the new schema is applied.

</consequences>
