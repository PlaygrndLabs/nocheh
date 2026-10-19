# ADR-0153: The owner re-runs or replaces Honcho memory

<status>
Accepted on 2026-10-19 for the owner's request "we need a feature to able re run
memory even can replace memory with new one". Builds on
[ADR-0115](0115-honcho-session-revisions.md) and
[ADR-0122](0122-honcho-fresh-start.md).
</status>

<context>
From about October 13 to 18 the memory provider rejected every Honcho model
call. Nocheh's writes reached Honcho, but Honcho's deriver marked each failed
learning task processed with its error, and Honcho never retries such a task.
The only remedy was a manual edit of Honcho's queue on the owner's computer.
Nocheh already had two rebuild mechanisms: a targeted session rebuild
(ADR-0115) used for corrections, and a fresh start to a new, empty workspace
(ADR-0122). Neither was reachable from the dashboard, and the fresh start could
not learn earlier messages again.
</context>

<decision>

Long-term memory in the dashboard gets a "Re-run or replace" card with three
actions, each showing what it would send before it runs. The same actions are
in `./bin/nocheh memory honcho`.

- **Retry failed learning** (`POST /v1/memory/honcho/retry-failed`,
  `retry-failed`). A Honcho plugin route returns the current workspace's failed
  `representation`, `summary` and `dream` tasks to Honcho's own queue by clearing
  `processed` and `error`. Honcho reruns them on the messages it already holds;
  nothing is resent and no message changes. The workspace is marked building so
  readiness waits for the rerun. A plugin count of failed tasks feeds the
  estimate without exposing payloads or error text.
- **Re-learn chats** (`POST /v1/memory/honcho/rebuild`, `relearn [--chat ID]`).
  Every chat, or chosen chats where a group includes its topics, are mapped to
  their Honcho sessions by audience. One `relearn:<session>` Honcho job per
  session runs the existing session rebuild: still-valid writes move to a new
  session revision, invalid ones (a retired message, withdrawn consent) are
  dropped, and the old session leaves Honcho with every conclusion derived from
  it. Rewritten messages carry their Telegram time. A rebuilt session has a new
  ID, so asking twice before the job runs re-learns it once.
- **Replace long-term memory** (`POST /v1/memory/honcho/fresh-start` with
  `from_archive`, `fresh-start [--from-archive]`). The fresh start optionally
  turns history ingestion on for the new workspace. Its owner command already
  pages the archive, so every saved message the owner allows is learned again
  into the new workspace; without `from_archive` it starts empty as before. The
  dashboard requires typing "replace".
- `GET /v1/memory/honcho/rebuild[?space=…]` estimates all three: failed tasks,
  the conversations and saved messages a re-learn would resend, and an upper
  bound of saved messages a replacement would resend. The card states the model
  cost and the remaining monthly memory thinking requests.

</decision>

<consequences>
- A provider outage is repaired from the dashboard by one retry, at the cost of
  rerunning only the failed learning.
- Re-learning and replacing resend messages and rerun Honcho's model calls, so
  they cost money and count toward the monthly limits. While deletions of
  replaced sessions are pending, replies read no Honcho memory, as for any
  correction (ADR-0148, ADR-0149).
- Re-learning also re-dates messages written before Honcho messages carried
  their event time.
- The retry route writes to Honcho's internal queue table of the pinned Honcho
  revision; a Honcho upgrade must recheck that table's meaning.
</consequences>
