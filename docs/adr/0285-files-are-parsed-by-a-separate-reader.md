# ADR-0285: Files are parsed by a separate reader, away from every key

<status>
Accepted on 2026-11-23. The owner approved this fix in the November security review: the code that
parses the files people send runs in a service of its own, with no network and no key. Amends
[ADR-0192](0192-files-are-read-by-the-runtime-document-reader.md),
[ADR-0193](0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md) and
[ADR-0194](0194-images-are-read-by-the-runtime-vision-tool.md) (where the bytes are parsed) and
[ADR-0251](0251-fixes-that-lose-nothing.md) (what Hermes's `/tmp` holds).
</status>

<context>
- Groups are read whole, from everyone ([ADR-0264](0264-groups-are-read-whole-from-everyone.md)),
  so anyone in a group can send a document, picture or recording that Nocheh parses.
- Hermes's document reader, Pillow and ffmpeg parse bytes that sender chooses. They ran in
  children of Hermes: with no service token, but as Hermes's own login, in Hermes's network, next
  to Hermes's processes and files. A parser bug there reaches what Hermes can reach.
</context>

<decision>
1. **nocheh-reader.** A service in the Hermes image (`python -m services.reader.server`). It has
   no network (`network_mode: none`), no key, no token and no state; its root is read-only and
   `/tmp` is memory. Hermes reaches it only through a Unix socket in the `reader_socket` volume,
   which only the two mount: one JSON line `{kind, hint, size}`, then the bytes; back comes one
   JSON line, then the bytes the reader made, if any.
2. **One login per file.** The server runs as root with only `SETUID`, `SETGID` and `KILL`
   (`no-new-privileges`). Each file is read by `services/reader/child.py` in a new process under
   one of a few logins of its own (`NOCHEH_READER_UIDS`, not Hermes's), with no extra groups, a
   home of its own at `0700`, and limits on time, memory, file size, open files and processes.
   Two files read at once run under two logins, so one cannot reach the other.
3. **Nothing left behind.** After each file, timeouts included, the server ends every process of
   that login and, as that login, removes everything it wrote in `/tmp` and `/dev/shm`. Only then
   is the login free for the next file. The socket's folder is root's, so a child cannot replace
   the socket.
4. **Only safe things come back.**
   - document: its text, read by Hermes's own document reader as before.
   - image: the picture decoded, turned the way its EXIF says, and encoded again as a PNG of at
     most 2048 pixels a side; over 60 million pixels is `too_large`.
   - audio: the length ffprobe measured, and the sound encoded again as mono 16 kHz Ogg Opus,
     without metadata or pictures.
   Hermes checks a made file starts as a PNG or Ogg file, then sends only that to the vision
   tool or transcriber, in the child that holds that provider's key.
5. **Busy is later.** A file waits up to 20 seconds for a free login. A reader that is busy or
   cannot be reached answers Hermes with 503, so the preparation step tries the file again later.
   A file that takes too long is unreadable (a recording: too large), not tried again.
</decision>

<consequences>
- A parser bug reached by a hostile file runs with no network, no key, under a login that
  owns nothing but its own home, and ends with that file.
- One reader serves the owner's and every group's files. A separate reader per audience would add
  nothing: no two files share a login at once, and nothing of one file stays for the next.
- The model and the transcriber still decode what the reader made. A file that breaks the reader
  and then makes a hostile PNG or Ogg must also break that decoder, on a format far narrower than
  the original.
- Hermes's `/tmp` no longer holds the files people send, only the PNG or Ogg the reader made.
  A full `/tmp` in the reader shows as a document that could not be read, or as a retry.
- Installs gain one service. Without root (as in a plain test run) the reader still works, but
  every file runs under the server's own login.
</consequences>
