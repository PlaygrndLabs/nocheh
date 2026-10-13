# ADR-0146: Save sits in the page header, not in a card at the bottom

<status>
Accepted on 2026-10-13 by the owner's feedback. Supersedes only the placement of
the save bar in [ADR-0145](0145-rebuilt-owner-dashboard.md); one shared draft
store and save-then-apply in one step stay.
</status>

<context>
On the live dashboard, the owner looked at the save bar while a provider change
was applying and said: "dont like this card for saving" and "actually dont like
have card in bottom".
</context>

<decision>

- While anything is unsaved, saving, applying, or failed, the page header stays
  at the top of the screen and shows, at its right, the state ("2 unsaved
  changes", "Saving…", "Applying…", "Couldn’t save"), Discard and Save. There
  is no bar or card at the bottom of the screen.
- The outcome of a save is a short message that disappears on its own; a failed
  save also keeps its reason in plain words under the header until the next try.
- The controls live in `dashboard/ui/save-bar.tsx` and are placed by the shared
  page frame (`dashboard/ui/page.tsx`), so every page shows them the same way.

</decision>

<consequences>
Save is always one click away at the top of the screen. The header takes a line
more space while edits are unsaved.
</consequences>
