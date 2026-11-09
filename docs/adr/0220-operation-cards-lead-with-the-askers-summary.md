# ADR-0220: Operation cards lead with the asker's summary

<status>
Accepted on 2026-11-09, after the owner saw Notion cards that list every field,
such as `parent › page_id` and `properties › "date:Asked on:is_datetime"`, and
asked for "AI text" that explains what will be done: "ai say want to do this
short and get my approve and done, thats what I want is simple flow". Amends how
[ADR-0213](0213-operation-cards-read-in-words.md) shows an operation's arguments
and how [ADR-0204](0204-a-jobs-changes-come-on-list-cards.md) lists a job's
changes; keeps what they decide about exactness, limits and the list-card split.
</status>

<context>
- ADR-0213 shows every field of the exact input in words. That is exact, but a
  Notion call is mostly IDs, types and column formats, so the card is long and
  the owner has to work out what it does.
- The model that asks for an operation already knows what it is for, with names
  instead of IDs, and writes the same thing in its reply. A second model call in
  Nocheh to describe the call would add cost and time, and would see only the
  IDs.
- A summary written by the asker is not the operation. A model misled by text it
  read could describe one thing and ask for another, so the card must still show
  what runs.
- Telegram allows bold inside a quote, but no quote inside a quote and no code
  inside a quote.
</context>

<decision>
- The shell, browser, MCP and Notion tools take an optional `summary`: one short
  plain sentence for the owner, in the conversation's language, saying what the
  call will do with names instead of IDs. Hermes sends it beside the exact
  arguments, never in them. Nocheh accepts it as text only. It collapses
  whitespace to one line and leaves out a summary that is blank or longer than
  500 characters.
- The summary is content: a derived record beside the proposal, with the same
  secret check as the arguments, run at the same time. Each wording is its own
  record. The action row keeps a reference to the first one it was asked with,
  so a repeat of the same request never changes its card. The summary is not
  part of the action's identity, fingerprint, rule key, grants or what runs, and
  if its check cannot finish, the card has no summary. Only the owner's view,
  the card and the dashboard Inbox, shows it.
- On a card, the summary is the `{summary}` line under the operation's name. The
  default template is `⚙️ {kind}`, `📝 {summary}`, then `💬 Asked in {origin}`.
  The name in bold still comes from the exact call, so the asker cannot change
  it. A saved template without `{summary}` gets the line under its `{kind}` line.
  The summary is never bold. It is shown as written, or quoted with hidden
  characters written out when it hides one, starts with `"` or holds `⚙`, under
  the same rules as a value. It is left out when, written out, it is longer than
  600 characters, or when the card would not fit Telegram with it.
- With a summary, the exact arguments fold into one expandable quote that opens
  on a tap. It starts with the owner-editable heading `details` ("Exact
  details") in bold, then the same fields as before, their labels still bold.
  Inside the fold, a long value has no quote of its own, which Telegram forbids.
  Its lines follow its label, each indented by two spaces, so no line of a value
  starts a line as a label or a group's name does, and none is bold.
- A shell command, and an input whose keys read alike, stay open in code under
  the summary, because Telegram cannot put code in a quote. With no summary, a
  card is exactly as ADR-0213 shows it.
- On a list card, each change shows its summary on a `📝` line under its numbered
  name, with its fields folded under it. A change that would not fit the card
  with its summary is listed without it, by the same rule every time, so a
  decided card keeps its text.
- The Hermes gateway also refuses entities that nest as Telegram forbids. Two
  entities may share text only when one holds the other and one of them is bold.
  None may overlap code. So a renderer mistake fails in tests and is never sent.
- The dashboard Inbox shows the summary as "The assistant says" above the exact
  details.
</decision>

<consequences>
- A Notion card reads as one line of what will happen and the Approve and Reject
  buttons. The fields stay one tap away.
- An owner who approves from the summary alone trusts the asker's words. The
  bold name, which comes from the exact call, still says which service and
  action it is, and the fields are on the same card.
- A model that does not send a summary gets the ADR-0213 card. The tool schema
  asks for a summary on every call that may wait for approval.
- The summary costs one more secret check per operation that has one. It runs
  beside the arguments' check, so the card waits no longer.
</consequences>
