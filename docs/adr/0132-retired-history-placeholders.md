# ADR-0132: Withheld Hermes history rows name the retired source

<status>
Accepted on 2026-10-11 at the owner's direction. Extends
[ADR-0123](0123-retired-sources-leave-native-history.md); restoring a message
still does not rebuild Hermes' stored history.
</status>

<context>
ADR-0123 rewrites a retired turn's rows in Hermes' `state.db` with generic
notices ("Retired message withheld; its content is unavailable."), and a
withheld reply or tool row did not say which source caused it. Asked whether a
restored message should be rebuilt into Hermes' old history, the owner chose not
to, and asked that a retired message be replaced with a notice that says it was
retired and gives its message ID.
</context>

<decision>

- A retired message's stored row becomes `[Retired message: nocheh:event:<id>]`,
  its Archive source ID. The marker pattern accepts this notice, so later checks
  still find the row's turn, for example when its reply is retired afterwards.
- A retired delivered reply becomes `[Retired reply: nocheh:event:<reply id>]`.
  Storage's `POST /internal/sources/retired` reports `answered` as a map from
  each recorded message to the IDs of its retired delivered replies.
- A tool result or reply withheld because it came from or cited a retired
  source names those sources:
  `[Tool result withheld; its source was retired: nocheh:event:<id>]` and
  `[Reply withheld; it used a retired source: nocheh:event:<id>]`. A tool-call
  row with no text keeps empty text and cleared arguments.
- Compaction summaries keep the general notice, since they may cover any
  earlier row.
- Hermes native notes (ADR-0129) still drop whole entries rather than keep a
  placeholder: notes load into every turn's prompt and have a small size limit.

</decision>

<consequences>

- Hermes and the owner can tell from stored history that a message existed and
  was retired, and find it in Archive by ID, without seeing its content.
- Placeholders cite the retired IDs, so rechecks recompute the same text and
  rewrite nothing; a restored source leaves its placeholder in place.
</consequences>
