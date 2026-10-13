# ADR-0147: Save is always present on pages that edit settings

<status>
Accepted on 2026-10-13 by the owner's feedback. Refines
[ADR-0146](0146-save-in-page-header.md): Save stays in the page header.
</status>

<context>
With Save appearing only once an edit started, the page header became pinned and
its description moved, so the page jumped. The owner wrote: "خراب میشه دیکمه
سیو همیشه باشه فقط غیر فعال باشه" (it breaks; the Save button should always
be there, just disabled).
</context>

<decision>

- Settings and Chats, the pages that edit settings, always show the pinned
  header with "No unsaved changes" or the current state, Discard and Save. Save
  and Discard are turned off while there is nothing to save, and while saving.
- Other pages show the controls only while something is unsaved, as before.

</decision>

<consequences>
Starting an edit changes no layout on the pages where edits happen.
</consequences>
