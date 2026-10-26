# ADR-0165: An approval card is the whole answer and links where its message goes

<status>
Accepted on 2026-10-26, during the rerun of release test 2 on the upgraded
installation. The owner asked in the private chat for a post to the test group,
got the card and then a separate answer repeating the draft, and said: "dont
need separated response all should be in one with actions, also should point
group name (linked text) and target topic it its supper gp." The card also said
only "a Telegram group", because names came only from the owner's last chat
refresh. Extends [ADR-0158](0158-telegram-approval-buttons.md) and
[ADR-0161](0161-requesters-review-their-own-cross-group-messages.md).
</status>

<context>
A card is posted while the turn that asked for it is still running. When the
card lands in the chat and topic where it was asked, the turn's own answer only
repeats it. A group's name was read only from `telegram_chat_observations`,
which the owner fills with an explicit refresh, and a topic was shown only as
"(a topic)", although captured messages carry the group's title, username and
forum flag, and a topic's creation or edit carries its name.
</context>

<decision>
- A card posted in the chat and topic where it was asked is the reply to the
  request message, and the turn is told to return `[NO_REPLY]` unless
  something else needs an answer. A card in the owner's private chat for a
  request made in a group still leaves the group a short note that the owner
  was asked.
- The card names the destination group from its latest captured messages, or
  else the owner's last refresh, and for a forum also its topic: the topic's
  name from its latest edit or its creation, or the name the owner gave it,
  else the editable "a topic"; a forum message without a topic shows the
  editable "General". The `topic` line of the card texts places the topic name
  with `{topic}`.
- The group's name, the topic's name and the "Asked in" group are Telegram text
  links where Telegram has an address: `t.me/<username>/…` for a public group,
  `t.me/c/<internal id>/…` for a private supergroup, which opens only for its
  members, to the group's latest captured message, the topic, or the request.
  A basic group has no address and stays plain text. The links travel as
  entities with UTF-16 offsets beside the plain text, so templates stay plain
  text, and the Hermes runtime accepts only `t.me` addresses within the text.
  The decided card keeps them.
</decision>

<consequences>
- The person asking sees one message: where it goes, the exact text, and the
  buttons, then the outcome on the same card.
- Names follow the chat as Nocheh sees it, without a manual refresh; a topic
  that Nocheh has never seen a message from shows as "a topic" until the owner
  names it.
- The turn's silence depends on the model following the tool result, as for
  same-group posts in [ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md).
</consequences>
