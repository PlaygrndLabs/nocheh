# ADR-0145: The owner dashboard is rebuilt around eight plain pages and one save bar

<status>
Accepted on 2026-10-13 by the owner's request. Supersedes the page structure and
settings flow of the 2026-10-12 dashboard redesign, the three-dimensional
evidence view of [ADR-0026](0026-three-dimensional-evidence-view.md) and the
editable memory map of [ADR-0058](0058-semantic-react-flow-memory-map-editing.md)
and [ADR-0059](0059-elk-layered-memory-map-layout.md) inside the owner
dashboard. The shared component direction of
[ADR-0050](0050-dashboard-components-and-workflow-metrics.md) stays.
</status>

<context>
The owner reported: "add custom api not work. the work flow and ui update after
save is bad, save btn is not in good place and lots of other ui/ux issue, the
issues are not limit to this page every where of dashboard we have kind of
these issue. need to check app fully and do a refactor to make dashboard simple
and usable, dont notice current impel and should think about every thing that
nothing exist prev."

The previous dashboard had two save paths for settings (a review, save and
apply bar in Settings, and save-then-apply buttons in Chats & access), applied
settings without following the result, approved actions in two places, kept
two editors for facts, projects and the agent copy, and rendered most layout
from a 7,000-line stylesheet.
</context>

<decision>

- Pages, in order: Home, Inbox, Chats, Messages, Memory, Usage, System and
  Settings. Projects is a Memory tab; usage and reply speed are their own page.
  Tabs are part of the address (`?view=`), and an open item is a detail in the
  address too, so links and Back work. Older page names and tab names are
  rewritten to the page and tab that now hold the content
  (`dashboard/lib/routes.ts`).
- Every edit to `.env` settings, from any page, is a draft in one shared store
  (`dashboard/lib/settings.ts`). Other forms with unsaved edits register with
  the same store (`dashboard/lib/drafts.ts`). While anything is unsaved, one bar
  sticks to the bottom of the screen with the list of changes, Discard and Save.
  Save writes the settings and then applies them in one step, follows the apply
  job to its end, reloads the saved values and reports the outcome there. A
  failed apply keeps the edits; a refused save shows the server's reason.
- Item actions that are not settings (approve, revoke, hide a message, correct
  a fact) act at once from the item's side panel, with a busy state, a toast,
  an inline error in plain words, and a refresh.
- Model providers are added and edited in a dialog that checks the address and
  key by listing the provider's models before it is added.
- The UI uses a small set of shared components (`dashboard/ui`) and Tailwind
  semantic colour tokens only; there is no page stylesheet.
- The 3D evidence graph and the React Flow memory map are removed from the
  owner dashboard; people, facts and relationships are lists with side panels.

</decision>

<consequences>
The dashboard no longer depends on `@xyflow/react` or `elkjs`. The native
Hermes graph module is unaffected. Owner-facing text avoids internal service
names where a plain word works. Owner review of the new structure is tracked in
TASK.md.
</consequences>
