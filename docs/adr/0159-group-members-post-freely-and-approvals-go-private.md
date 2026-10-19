# ADR-0159: Allowed members post freely in their own group; approvals go to the owner privately

<status>
Accepted on 2026-10-19 after release test 2 on the owner's installation. The
owner asked in the test group for a post in that group, the post waited for
approval with a button card in the group, and Nocheh's group reply said it had
drafted the post. The owner asked why a post in the same group needs approval,
asked for approval talk to happen in the private chat, and asked Nocheh to
refuse people who are not allowed with a fixed message. Supersedes the card
placement in groups from [ADR-0158](0158-telegram-approval-buttons.md).
</status>

<context>
A group turn reads only that group's memory (and, with separate topic memory,
only its topic). A post it makes in the same audience reveals nothing a reply
there could not. Messages from people the owner has not allowed in a group are
captured and then silently ignored.
</context>

<decision>
- A Telegram message that the owner or a permitted participant asks for in a
  group, for that same group, is approved by the request, like the owner
  freedom level does for the owner's private requests. With separate topic
  memory only the same topic counts. Deny rules still apply first. The model
  is told the post is going out and to add no separate announcement.
- Everything else from a group still waits for the owner: messages to other
  chats and shell, browser and MCP operations. Owner-private requests keep the
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
- The owner and permitted members can have Nocheh post in their own group
  with no approval round trip.
- Pending approvals never show drafts to a group.
- People who are not allowed learn why Nocheh does not answer them, at most
  once per message, and only when they address it.
</consequences>
