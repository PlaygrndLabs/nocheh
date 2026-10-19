# ADR-0154: A message edit replaces its earlier Honcho writes

<status>
Accepted on 2026-10-19 after the owner said yes to fixing the known gaps before
the release tests ("edited messages repeat in Honcho memory"). Extends
[ADR-0115](0115-honcho-session-revisions.md).
</status>

<context>
An edited Telegram message is captured as a new revision of the same message
object, with its own archive event. Honcho ingestion matched earlier writes
by event only, so an edit was written as one more message and Honcho held both
the old and the new text. The pinned Honcho can update only a message's
metadata and cannot delete a single message.
</context>

<decision>
For an incoming Telegram message, the latest captured revision in Telegram
update order is the only one written to Honcho memory.

- Queuing a revision that is not the latest writes nothing.
- Queuing the latest revision treats the live writes of every earlier revision
  as stale, so ADR-0115's targeted rebuild replaces each session that held
  them: the earlier writes are dropped, the rest moves to a new session
  revision, and the old session leaves Honcho with its conclusions.
- A receipt of an earlier revision is no longer valid, so a later rebuild never
  carries it forward.

Delivered assistant messages keep their earlier behaviour, because their edits
(for example removing approval buttons) rarely change what was said.
</decision>

<consequences>
- Honcho memory holds only what a message says now.
- An edit of a message already in Honcho rebuilds its conversation session and
  re-derives that session's messages, at the same cost as a correction. Replies
  read no Honcho memory until the replaced session is deleted (ADR-0149). An
  edit that arrives before the original was written costs nothing extra.
- Learned interpretations whose evidence is the earlier revision are not
  replaced by this decision.
</consequences>
