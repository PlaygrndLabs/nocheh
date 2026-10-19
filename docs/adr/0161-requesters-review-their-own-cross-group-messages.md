# ADR-0161: The person who asked reviews their own message to another group

<status>
Accepted on 2026-10-19, before the live check of
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md). The
owner said that for a message from group A to group B by the owner or an
allowed member, "allowed memeber can approav we use approve to just let sender
can see what will be send cuz memory of both gp are private", and that only
the owner or an allowed member can use Nocheh at all. For another topic of the
same group with separate topic memory, the owner said it "should behavie like
like GP level". Supersedes the owner
reviewing such messages from ADR-0159.
</status>

<context>
A message asked for in group A for group B is made from group A's memory, so
it is shown before it is sent. When the person asking is allowed in both
groups, the review is for that person to see exactly what goes to B; the owner
does not need to decide it. A bot cannot open a private chat with a member who
has never started one, and the draft holds only group A's memory, so group A is
where that person can see it.
</context>

<decision>
- A Telegram message that a permitted participant (not the owner) asks for in
  a live group turn, for another group where that same person is also
  allowed, or for another topic of the same group when topics keep separate
  memory, gets its Approve and Reject card in the group and topic where it was
  asked, without the "Asked in" line. Only that person or the owner can decide
  it; anyone else's press is answered and decides nothing.
- The owner's own requests from a group for another group, requests for a
  group where the person asking is not allowed, and every other pending action
  keep their card in the owner's private chat.
- The Hermes gateway accepts a card for the owner's private chat or for an
  allowed group, with an optional topic, bound to that chat and topic.
- Whoever decides, the decision, receipt and Inbox record are the same as for
  an owner's press.
</decision>

<consequences>
- Allowed members move content between their own groups without waiting for
  the owner, and still see the exact text before it is sent.
- A cross-group draft is visible to group A's members, who can already read
  group A's memory.
</consequences>
