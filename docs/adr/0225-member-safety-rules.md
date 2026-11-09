# ADR-0225: Member safety rules for Notion, chat rules and Honcho peer cards

<status>
Accepted on 2026-11-09, after the owner asked whether a coworker they let use
Nocheh can use their Notion workspace or reach groups the coworker is not in, and
said "yes" to five safety fixes found while answering. Amends
[ADR-0175](0175-notion-through-its-mcp-server.md): a read whose input names an
address outside the owner's Notion is a change, and the executor checks again
where a Notion call came from. Amends
[ADR-0203](0203-owner-approved-jobs-read-notion.md): a job keeps the Notion access
it was approved with, instead of a card line computed when drawn and the current
setting alone. Amends the job-step fetch rule of
[ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md), which becomes one
rule for every read, and the peer-card consequence of
[ADR-0115](0115-honcho-session-revisions.md): Nocheh reads no peer card. Extends
[ADR-0214](0214-allow-a-site-or-command-in-one-chat.md): a card says whom a chat
rule covers.
</status>

<context>
- Notion's read tools take addresses as well as IDs. A read of a page someone
  else runs, such as a public `*.notion.site` page, or a search or query whose
  text holds a web address, can send what its input holds to that address. Text
  a member wrote in a group can steer what a job of the owner asks for. Only a
  job's fetch was checked, and only its `id`.
- A job's card said what it may read when the card was drawn, and the current
  setting decided each call, so turning reads on after Approve gave an approved
  job reads its card never showed.
- That a Notion call comes from the owner's private chat, or from a job the owner
  asked for and approved there, was checked when the call was proposed, not again
  when it ran.
- A chat rule set from a card covers everyone allowed in that chat or topic: it
  matches the site or command, the chat or topic, the profile and the
  installation generation, never the person who asked. The card did not say so,
  and named the group without its topic.
- A Honcho peer card is one summary of a person across every session. Honcho's
  session-filtered chat, which group recall and learning use, still adds the
  speaker's card (an open upstream gap), and its context read returns the card
  unless the read is limited to the session. Dreams, which write cards, were
  already off, so no card is expected to exist; the risk is a card written
  earlier or by a later Honcho change.
</context>

<decision>
- **Outside addresses ask first.** In a live private turn and in a job, a Notion
  read runs without its card only when every address in its input is in the
  owner's own Notion: a raw ID; `collection://`, `view://` or `user://` by ID;
  `discussion://` by its IDs; or `https://notion.so` or `https://www.notion.so`
  written plainly, by ADR-0214's plain-host rule (no backslash, percent escape,
  user name, written port or second address), with only the `v`, `p`, `pvs` and
  `source` query keys and a plain fragment. Every value under an address key
  (`id`, `page_id`, `page_url`, `data_source_url`, `data_source_urls`,
  `view_url`, `discussion_id`, `url`, `urls`) is checked, and so is every
  address written with a scheme anywhere else in the input, keys included:
  from each `http:` or `https:`, however its slashes or backslashes are
  written, and each other `scheme:` followed by a slash or backslash, with
  tabs and newlines dropped first as URL parsers drop them. A web address with
  an `@` before its first slash is checked up to that slash, past any quote or
  bracket, since a parser reads the host after the `@`. Free text without a
  scheme, such as a search query or a bare host name, is fine. Anything else
  counts as a change. A query string is never stripped, since what runs is what the card
  shows; any other query key makes the read ask.
- In a job, a fetch also keeps its narrower rule: only an `id`, beside switches,
  naming a page, data source or view. Under "Nothing asks me", a change in a
  live private turn runs, so an outside-address read there runs too; in a job it
  always asks. The addresses are found in one pass, so an input at the
  32,000-character cap is checked in milliseconds.
- **A job keeps the Notion access it was approved with.**
  `background_jobs.notion_reads` is set when the job is asked, to what its card
  offers: reads for the owner's own private job while Notion is on and not
  everything asks. Approve narrows it by the setting at that moment; Reject
  leaves it. The card shows the saved value. A job's read skips its card only
  while that value is true and the current setting still lets reads run. The
  value is not part of the job's fingerprint, since it only narrows.
- **Recheck who asked right before a Notion call runs.** The executor's claim
  blocks a Notion call that is not from the owner's private chat
  (`notion_owner_private_only`), or whose job is not one the owner asked for in
  that chat and approved, under the same profile, or whose read the setting let
  through while the job has no Notion reads (`notion_job_not_approved`). A
  scheduled task's call has no background job: it runs only by its own card or
  the owner's exact permission, never by the setting. Its card says it did not
  run because something changed after it was asked.
- **A chat rule's card says it covers everyone.** A card that offers Allow where
  asked or Always allow for a group or topic names the topic too, and ends,
  right above its buttons, with the owner-editable line `rule_note`: "👥 “Where
  asked” covers everyone you allowed in that chat or topic, not only the person
  who asked." The asker's summary is left out before the note is, and a card the
  note does not fit offers no rule buttons, so a rule is never offered without
  saying whom it covers. A card for a request asked in the owner's private chat
  has no note, since only the owner asks there. Real scheduled runs carry
  their schedule's job and so offer no rule; a schedule turn without one would
  name the chat its rule covers (`from_schedule_in`). A card for a request
  with no Telegram message to point to, such as a dashboard run for a group,
  names the chat and topic it ran for. The replies after Allow where asked and
  Always allow say the rule is for everyone in the chat or topic that asked.
- **Honcho peer cards stay off.** The generated `honcho.env` pins
  `PEER_CARD_ENABLED=false` beside `DREAM_ENABLED=false` and is written again on
  every setup. Nocheh reads no peer card into any context, the owner's included.
  This is defense in depth: it keeps a card written earlier, or by a later
  Honcho change, out of every read.
</decision>

<consequences>
- More cards: a fetch of `memory` or of Notion's own docs, a search holding a web
  address, and a person filter by `bot://` all ask.
- Turning Notion reads on after Approve does not widen an approved job; the owner
  asks for a new job. A waiting card posted while reads ran can still show the 📒
  line after the owner switches to "Everything asks me"; Approve then keeps no
  reads, and the settled card drops the line.
- Jobs asked before the column existed have no Notion reads, so their reads ask.
  No migration is needed in development mode.
- An owner who saved "Approval buttons and results" keeps their saved
  `allowed_here` and `allowed_always` lines; the new `rule_note` and
  `from_schedule_in` lines come from the defaults. An emptied note keeps its
  default, so the note can be reworded but not removed.
- When the Honcho pin moves, `PEER_CARD_ENABLED` must still exist and still turn
  peer cards off. A Honcho workspace or session configuration Nocheh sets later
  must not turn them back on.
</consequences>
