# ADR-0191: Imports share secret checks and become ready when prepared

<status>
Accepted on 2026-10-29, after the owner approved the build of the chat-review
plan ("I all thing is ready start build."). Extends
[ADR-0127](0127-parallel-guard-checks.md) and
[ADR-0139](0139-reply-checks-before-background-checks.md) for imported
history.
</status>

<context>
- Every imported message was checked for secrets in its own model call. A
  large chat export of tens of thousands of messages meant tens of thousands of
  calls: hours, and a cost far above the messages' size.
- Each import batch of 50 messages sent the whole original export again and
  parsed the whole messages file again. The messages file was limited to 32 MiB,
  and the original export to the 50 MiB file limit.
- An import counted as done when its messages were written, while their files
  were still being read and their text still checked. Questions about that
  history then saw only part of it, without saying so.
</context>

<decision>
- An imported message's preparation checks its own text together with up to
  200 other unchecked messages of the same import, about 120 KB of text, in
  shared detector calls of at most 50,000 characters. Text repeated across them
  is checked once. A secret found in one message is hidden wherever it appears in
  that page. Each companion message stays locked during the check, so its own
  preparation waits and then finds its text already checked; its files are still
  read and checked by its own preparation. A page the checker rejects is retried
  as the one message alone, so one message can never hold back the others.
- Import checks use the background priority, so checks for replies go first.
- The import job parses the messages file once into a private line-per-message
  file beside the job and reads each batch from it. The original export is sent
  once, with the first batch, as one file or in 32 MiB numbered parts with their
  offsets. The messages file may be up to 128 MiB, and the dashboard sends large
  files in 16 MiB pieces.
- An import is ready once every message it brought has a settled preparation:
  prepared, skipped or failed. The store's worker marks it ready and sends the
  owner's private Telegram chat one editable notice (Settings › Instructions ›
  Import ready). Until then the Import page shows how many messages are
  prepared, have files to read or wait for the secret check, and archive search
  in a chat whose history is still importing says how far along it is. A group
  never sees the names of other chats in the same export.
</decision>

<consequences>
- A large import needs one detector call per page of messages instead of one
  per message.
- A literal found in one message is also hidden in other messages of its page,
  which is stricter than checking each alone.
- Failed preparations still let an import become ready; the notice says how
  many failed, and Health keeps the details.
</consequences>
