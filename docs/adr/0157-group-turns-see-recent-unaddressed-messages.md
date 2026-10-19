# ADR-0157: A group turn sees the recent messages not addressed to Nocheh

<status>
Accepted on 2026-10-19 after release test 1 on the owner's installation: in
the test group the owner wrote "Anyone up for lunch tomorrow?" without
addressing Nocheh, then replied to Nocheh with "What did I just ask the
group?", and Nocheh quoted an older question addressed to it instead.
</status>

<context>
Every group message is captured, but a message that does not address Nocheh
is suppressed as `not_addressed` and never reaches Hermes. Hermes' native
history holds only turns, so a reply saw the conversation with Nocheh but not
the group conversation around it. Honcho memory learns those messages later
and is not a record of what was just said.
</context>

<decision>
- A group or topic turn carries the group messages captured in the same
  conversation space since the last turn there: messages suppressed as
  `not_addressed` or from members who may not talk to Nocheh
  (`conversation_not_selected`), at most 20, from the last 12 hours, oldest
  first. Album parts are skipped; any other dispatch outcome is the previous
  turn and ends the list.
- Each message is the guarded copy this conversation may read, at most 1,000
  characters, labeled with the same speaker line as the turn and citing its
  archive source. A retired message, or one whose guarded copy is not
  readable, is left out.
- Hermes puts these messages before the turn's own speaker line and text,
  outside the Honcho memory query. They become part of that turn's native
  history, so later turns do not repeat them.
</decision>

<consequences>
- A group reply knows what was said just before it, by whom and when.
- Retiring one of those messages later withholds the turn that carried it,
  because the stored turn cites its source.
- Messages older than 12 hours or beyond the last 20 since the previous turn
  reach a reply only through archive search or Honcho memory.
</consequences>
