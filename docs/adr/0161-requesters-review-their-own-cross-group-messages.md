# ADR-0161: The person who asked reviews their own message to another group

<status>
Accepted on 2026-10-19, before the live check of
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md). The
owner said that for a message from group A to group B by the owner or an
allowed member, "allowed memeber can approav we use approve to just let sender
can see what will be send cuz memory of both gp are private", and that only
the owner or an allowed member can use Nocheh at all. For another topic of the
same group with separate topic memory, the owner said it "should behavie like
like GP level". During the live check the owner asked "Im owner why still
need approve when I ask nocheh to send my self pv msg from gp". Supersedes the owner
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
- A message the owner asks for in a live group turn, for the owner's own
  private chat, is approved by the request: that chat already sees all of the
  owner's memory.
- The owner's own requests from a group for another group, requests for a
  group where the person asking is not allowed, and every other pending action
  keep their card in the owner's private chat.
- The Hermes gateway accepts a card for the owner's private chat or for an
  allowed group, with an optional topic, bound to that chat and topic.
- Whoever decides, the decision, receipt and Inbox record are the same as for
  an owner's press.
- After the live check the owner asked "if possible improve msg style and use
  template". A card is filled from owner-editable templates in Settings ›
  Instructions: one for a message (`{destination}`, `{origin}`, `{text}`), one
  for a tool (`{kind}`, `{origin}`, `{arguments}`), and labeled lines for the
  buttons, outcomes and notices. A template line whose value is missing, such
  as where it was asked, is left out; the exact message or arguments must stay
  in the template. The texts stay in Nocheh and never reach the runtime.
</decision>

<consequences>
- Allowed members move content between their own groups without waiting for
  the owner, and still see the exact text before it is sent.
- A cross-group draft is visible to group A's members, who can already read
  group A's memory.
</consequences>
