# ADR-0271: A Connections page, by whom each connection belongs to

<status>
Accepted on 2026-11-21. The owner said the owner's own Notion, under Settings › Connections,
looked connected to all of Nocheh. Follows [ADR-0268](0268-notion-per-project-or-person.md)
and [ADR-0269](0269-github-per-project.md): a service connects to a project or a person.
</status>

## Context

Settings holds what the whole installation uses. The owner's own Notion sat there, so it read
as Nocheh's Notion, not the owner's. Each project's connections sat only in its drawer, so no
page showed who owns what.

## Decision

1. **Its own page.** Connections moves from a Settings tab to a page in the side menu, with
   three tabs:
   - **Yours**: the owner's own Notion ("Your Notion") and the GitHub repositories no project
     uses. They are used only in the owner's private chat and what the owner approves there.
   - **Projects**: one table, a row for each active project, with its Notion state and its
     repositories. Open goes to the project, where its connections are changed.
   - **GitHub app**: Nocheh's one GitHub app. Each repository is the owner's own or one
     project's.
2. **Sign-ins return here.** Every tab stays on the page, so a Notion or GitHub sign-in that
   comes back is finished whichever tab is open. That includes a project's Notion.
3. **Old addresses.** `#settings?view=connections` opens `#connections`, and `&tab=github`
   opens `#connections?view=github`.

## Consequences

- When members connect their own accounts later (step 5), a member's own accounts belong
  with that member, not under Yours.
- Checks: `test/dashboard-routes.test.mjs` and the Notion, GitHub and repository-link tests
  in `test/dashboard-pages.browser.mjs`.
