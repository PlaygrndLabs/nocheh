# ADR-0264: Groups are read whole from everyone

<status>
Accepted on 2026-11-19 by the owner, in place of fix 10 of the review of how
text from outside reaches Nocheh (cost and slowdowns from people not allowed in
a group). Supersedes the voice cap of
[ADR-0251](0251-fixes-that-lose-nothing.md) ("Photos and voice notes", its
15-minute part) and narrows nothing else of it: a photo is still read once, at
its largest size. Keeps [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md):
people in chats Nocheh does not serve still cost nothing and reach no model.
</status>

<context>
- Fix 10 proposed a daily reading budget per group for the files of people not
  allowed there, a notice with "Read them anyway", and one work slot always
  kept free for the owner by making their files wait their turn.
- ADR-0251 already cut a live recording from someone not allowed in a group to
  its first 15 minutes.
- The owner, 2026-11-19: "dont limit on income data in group from every one";
  "if a user isnt memeber we need to see their data and other content in group
  just didnt let tem to interaction with agent". Asked about a cost notice with
  no blocking and about queueing their files: "dont need now". Asked whether to
  remove the 15-minute cap: "yes".
</context>

<decision>
- In a group Nocheh serves, everything is read from everyone, members or not:
  messages, files, photos and voice notes, each read whole, with no daily budget,
  no held files and no cost notice. Only the owner and the members who talk
  there interact with the agent.
- Every recording is transcribed whole, whoever sent it. Nocheh asks the
  transcriber for no part, and the runtime takes no `first_seconds`; a request
  that names one is refused, and a stray one in the runtime's body is ignored.
- Other people's file reads are admitted like any other preparation; no slot is
  kept for the owner's work beyond what ADR-0080 keeps.
</decision>

<consequences>
- What reading their files costs is bounded only by what they post, and shows on
  the Usage page like any other reading.
- A long recording from anyone holds a work slot for as long as it takes to
  transcribe, up to the transcriber's time limit.
- Transcripts cut before this decision keep their note; a new reading from the
  dashboard gives the whole text.
- A transcription requested with a part before this decision and not yet done
  fails as an unsupported configuration (development mode: no port).
</consequences>
