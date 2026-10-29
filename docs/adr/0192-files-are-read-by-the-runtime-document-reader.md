# ADR-0192: Files are read by the runtime's document reader

<status>
Accepted on 2026-10-29 as part 2 of the chat-review build the owner approved
("I all thing is ready start build."). The owner asked for Nocheh to be "a
orcestrator/wrapper on the ai tools base on our policy" that covers only what
those tools don't provide, and accepted the reuse map ("looks fine"). Extends
[ADR-0191](0191-imports-share-secret-checks-and-become-ready.md).
</status>

<context>
- Nocheh read only PDFs with a text layer and small UTF-8 files. Word, Excel,
  PowerPoint and other documents in a chat kept only a "text extraction is
  unavailable" note, so questions about them found nothing.
- Hermes 0.22.5, which Nocheh pins, already reads documents for its own
  `read_file` tool: Word, Excel and notebooks with the standard library, and
  PowerPoint, old Office, OpenDocument, RTF, EPUB and PDF with the converter it
  bundles. With no hosted key configured, it calls no outside service.
</context>

<decision>
- Nocheh's preparation step sends a document's bytes, name and MIME type to the
  runtime's `file.extract` operation (Hermes: `/internal/extract`). The runtime
  reads it with Hermes's `tools.read_extract` in a child process that has no
  service credentials, a two-minute limit and a 2 GiB memory limit.
- The type comes from the file's extension, then its MIME type, then its first
  bytes. The original name never reaches the reader.
- Hermes's notes written for its own agent, such as the hint to render scanned
  pages, become one plain note. Scanned, unreadable, unsupported and oversized
  documents keep a status reading. Text is cut at one million characters.
- Plain UTF-8 files of up to 200 KB are still read in Nocheh. Images and video
  wait for their own reader. Readings made before this change stay, and an
  earlier request still completes with its own engine.
- The text is a derivative like any other: saved beside the original and
  checked for secrets before any use.
</decision>

<consequences>
- Office documents and PDFs in live chats and imports become searchable and
  readable by the agent after the secret check.
- A Hermes upgrade can change the reader's output, so the pinned version decides
  it; each upgrade reruns the reader check with made-up documents.
- A reader failure or hang affects only that file's reading, not the service.
</consequences>
