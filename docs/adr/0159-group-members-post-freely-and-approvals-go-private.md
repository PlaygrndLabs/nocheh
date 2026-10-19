# ADR-0159: Allowed members post freely in their groups; approvals go to the owner privately

<status>
Accepted on 2026-10-19 after release test 2 on the owner's installation. The
owner asked in the test group for a post in that group, the post waited for
approval with a button card in the group, and Nocheh's group reply said it had
drafted the post. The owner asked why a post in the same group needs approval,
asked for approval talk to happen in the private chat, and asked Nocheh to
refuse people who are not allowed with a fixed message. Before this change
merged, the owner added that a user with access to several groups who asks in
one for a message in another should not need approval either, since projects,
groups and each person's access combine freely. Supersedes the card placement
in groups from [ADR-0158](0158-telegram-approval-buttons.md).
</status>

<context>
A group turn reads only that group's memory (and, with separate topic memory,
only its topic), which the person asking can already read. A post it makes in a
group where that same person is allowed reveals nothing that person could not
post there themselves. Memory itself stays with each group: what other people
said in one group is not merged into another by a person's or a project's
membership. A group turn had no way to learn other groups' IDs. Messages from
people the owner has not allowed in a group are captured and then silently
ignored.
</context>

<decision>
- A Telegram message that the owner or a permitted participant asks for in a
  live group turn, for any group or topic where that same person is allowed
  (the owner in every selected group), is approved by the request, like the
  owner freedom level does for the owner's private requests. Deny rules still
  apply first. For the same chat the model is told to add no announcement; for
  another group, to confirm in one short sentence.
- A group turn can list the groups, with their known names and exact IDs,
  where the person asking is allowed (`nocheh_telegram_destinations`).
- Everything else from a group still waits for the owner: messages to the
  owner's private chat or to groups where the person is not allowed, and
  shell, browser and MCP operations. Owner-private requests keep the
  owner freedom setting (approval by default).
- Every Approve and Reject card goes to the owner's private chat and says
  where the request was made. When the request came from a group, the model
  is told to say there only, briefly, that it asked the owner.
- When someone not allowed in a selected group addresses Nocheh, it replies
  to that message once with a fixed text and starts no turn. The text is one
  of the owner-editable built-in texts (`telegram.not_allowed`). Hermes checks
  addressing as for turns, rechecks that the sender is not allowed, and keeps
  a receipt so a redelivered message is answered once.
</decision>

<consequences>
- The owner and permitted members can have Nocheh post in any of their groups
  with no approval round trip.
- Pending approvals never show drafts to a group.
- People who are not allowed learn why Nocheh does not answer them, at most
  once per message, and only when they address it.
</consequences>
