# ADR-0291: A group's tools permission runs only what carries no data

<status>
Accepted on 2026-11-24. The owner chose "Yes, ask when it carries data" for group
web reads that could carry data. Amends
[ADR-0260](0260-members-in-groups.md) ("Web pages and outside tools": what runs
without a card) and [ADR-0263](0263-only-addresses-no-model-built-open-without-a-card.md)
(which left members' group web reads unchanged).
</status>

<context>
- Under ADR-0260, a web page read or an outside tool asked for in a live group
  turn runs without a card while the asker's permission holds, and the owner's
  own request in a group does too.
- ADR-0263's one address check decides what opens without a card in the owner's
  private chat and under rules. A group turn reads its group, its project's
  memory and its project's Notion, and text others post there can steer the
  model (ADR-0260), so the same check belongs there.
</context>

<decision>

- `groupToolsGrant` still decides who may: the member's permission for web pages
  and outside tools, or the owner's switch. The proposal then runs the request
  without a card only while the asking message has reads left without a card,
  and only when either:
  - it is a web read or a tool list whose address is exactly a link no model
    built, by the same `freeRead` as "Do what I ask" (`typed`, `forwarded`,
    `page`, `named`) from the asking message, kept in
    `controlled_actions.free_read`; a tool call is never let in this way; or
  - it sends no data beyond a short address (`sendsNoData` in
    `src/link-check.ts`): its address carries no data by ADR-0263's check, for
    another server's tool call its input is short enough for a tool rule, and
    everything a model chose in it counts toward the same 200 characters: the
    site name, which a model picks here, the path and query, and a tool call's
    tool name and input.
- Reads under the permission count toward the message's 10 without a card, with
  reads a rule covers and reads "Do what I ask" opens: `freeReadsLeft` also
  counts rows with `authority='group_tools'`. Past 5 page links, a page link runs
  only as any other short request does.
- Anything else asks with its card, as every group request did before ADR-0260,
  and its row keeps no authority. Deny rules, the chat's tool switches, the
  refusal for a member with the permission off and the claim's member check stay
  as they are.
- A new web read or tool call must write its path as it is sent: a backslash or
  a `.` or `..` segment, escaped or not, is refused (`plain_path_required`), as
  ADR-0214 refuses a host that is not plain. A URL parser drops such a segment
  with the one before it, so every check would otherwise read a shorter address
  than the executor sends. This holds in every chat.
- No schema change.

</decision>

<consequences>
- Everyday reads, short searches, links people paste or forward and short tool
  calls keep running in groups with no card.
- A longer or address-carrying address, a tool call with longer input, and the
  eleventh read of one message wait for the owner's card.
- An address with a dot segment or a backslash in its path is refused, and the
  model asks again with a plain one.
- What opens without a card in a group stays within ADR-0263's limits for one
  message.
</consequences>
