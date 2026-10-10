# ADR-0129: Retired sources leave Hermes native notes

<status>
Accepted on 2026-10-10. Extends
[ADR-0123](0123-retired-sources-leave-native-history.md), which left Hermes
native notes as a separate, unchecked copy.
</status>

<context>
Hermes keeps small native notes in each profile's `memories/MEMORY.md` and
`memories/USER.md`, loads them into every turn's system prompt, and backs a
note file up as `MEMORY.md.bak.<time>` when it finds outside edits. A turn's
`memory` tool call can copy a fact from a message into a note with no source
citation; native memory reviews are asked to cite `nocheh:event:<id>`. After a
message was retired, its stored turn was withheld (ADR-0123) but a note
written from it could still repeat it in every later turn.
</context>

<decision>

- Before a turn starts, under the same profile turn lock as ADR-0123, the
  Hermes service removes whole note entries (Hermes' `§`-delimited entries) from
  the note files and their backups when an entry:
  - cites a retired event, or an event whose delivered answer is retired; or
  - is exactly the text that a `memory` tool call in a newly withheld turn
    wrote, read from the stored call before its arguments are cleared.
- Notes are checked on every turn, since a note can be written after the last
  history check. Their citations go in the same storage call that already
  reads the retirement revision, so an unchanged revision still costs one call.
- Files are rewritten atomically while holding Hermes' own `<file>.lock`.
- Owner native recall skips note lines that cite a retired event until the
  profile's next turn removes them.

</decision>

<consequences>

- A note entry that restates a retired fact in other words and cites nothing
  cannot be traced to its source and stays. Native reviews cite their sources,
  and live-turn memory writes are matched exactly.
- Removed note entries are not restored when the owner restores the message;
  the agent can write them again from the restored source.
</consequences>
