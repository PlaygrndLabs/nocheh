# ADR-0140: A cut-off learning result keeps its whole leading items

<status>
Accepted on 2026-10-12. Extends
[ADR-0128](0128-learning-results-keep-valid-items.md).
</status>

<context>
On October 12 three of twenty silent-learning (`interpret`) jobs on the
owner's development installation closed as failed with
`invalid_interpretation_result`. In each, Honcho's reasoning call used exactly
its 2,500-token output limit, and the saved answer stopped inside a string in
the entity suggestions or claims, after a complete interpretations array. The
JSON had no other defect. The whole answer was discarded, so the complete
interpretations it already contained were never learned.
</context>

<decision>

- When no complete JSON result can be read, Nocheh reads a result object that
  was cut off: it keeps every whole item of each section and every whole
  section before the cut, and drops the unfinished item and everything after
  it.
- A cut-off answer with no whole item stays unusable and closes the job, as
  before.
- The kept items pass the same validation as any other result item.

</decision>

<consequences>
- A learning answer that runs into the reasoning output limit still teaches
  what it finished saying.
- Items after the cut are lost for that job; the dropped tail is not recorded
  as a separate rejection.
- The output limit itself is unchanged.
</consequences>
