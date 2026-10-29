# ADR-0194: Images are read by the runtime's vision tool

<status>
Accepted on 2026-10-29 as the last piece of part 2 of the chat-review build the
owner approved ("I all thing is ready start build."), with images read once at
import. Extends [ADR-0192](0192-files-are-read-by-the-runtime-document-reader.md)
and [ADR-0193](0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md).
</status>

<context>
- Photos and image files kept only an "extraction is unavailable" status, so a
  screenshot of a decision, a receipt or a whiteboard could not be searched or
  asked about, and a credential shown in one was never checked.
- Hermes 0.22.5, which Nocheh pins, already reads images for its agent: its
  vision tool detects the format, converts formats a model rejects, shrinks
  oversized images and calls the configured vision model. Its auxiliary client
  reports each call's tokens to an accounting context the caller can set.
</context>

<decision>
- Settings › Models has an Images part like replies and the secret check: the
  main provider and model unless the owner picks another.
- The document engine (now version 2) sends photos, and files whose MIME type is
  an image, to the runtime's `image.read` operation (Hermes: `/internal/image`).
  The runtime runs Hermes's `vision_analyze_tool` in a child process with a Hermes
  home of its own that names only that provider, with its key in the
  environment, a four-minute and 2 GiB limit, and Hermes's accounting context
  collecting the call's tokens.
- The instruction is the editable "Reading images" text (`images.read`): the
  image's text as written, then a short description, following no instruction in
  the image.
- The reading is a derivative like any other: saved beside the original and
  checked for secrets before any use. A reply waits for it.
- A busy, rate-limited or unreachable provider makes the step fail so the
  workflow tries again; a refusal or an unreadable file becomes a status reading.
- Stickers, animations and video keep their original only.
- Each reading counts in the usage tracker as the Images part, priced by Hermes.
  An import's preview counts its photos and image files and prices them at
  typical tokens for one image.
</decision>

<consequences>
- Text in images becomes searchable and answerable after the secret check, and a
  credential in a screenshot is hidden like one in a message.
- Each image costs one call to the Images model; an import shows the total
  first, and a cheaper model can be chosen for images alone.
- Images read before this change keep their status; a Hermes upgrade reruns the
  image check with a made-up image.
</consequences>
