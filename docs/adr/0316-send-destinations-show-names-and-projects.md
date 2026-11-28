# ADR-0316: Send destinations show names and projects

<status>
Accepted on 2026-11-28, after a live test: the owner asked in one group to tell the group of another project a message,
and the agent answered that it could not tell which group was meant because no group in its list had a name. No card was
made. Amends the destination naming of ADR-0252 ("Runtime profiles, cards and destinations") and the id keys of ADR-0314.
</status>

## Context

- `telegram_destinations` (`TelegramActionRepository.destinations`) named a group only by the owner's last explicit
  refresh from Telegram (`chat_details.refreshed_title`), as before step 2b. A group the owner never refreshed had no
  name, however many messages Nocheh had captured there, and a later rename never showed.
- The owner's directory (`chatLabel`) and the approval card name a group by its captured title, as the specification asks
  ("Directory names come from captured Telegram observations").
- The owner often names a group by its project. Projects are the owner's own names; a project's chat never sees the
  names of other projects.
- Each destination is a 64-hex Nocheh chat id under the key `destination`, which `ownIds` did not count, so the secret
  check could hide it as it hid task ids.

## Decision

1. A destination's `name` is its chat's name as the owner's directory gives it: the title captured messages gave, else the
   owner's last refresh, else its public `@name`; null only when none is known.
2. In the owner's turn each destination also carries `project`: the name of the active project its group is in, or null.
   A member's list has no `project` field.
3. `destination` joins the id keys of ADR-0314, so a listed chat id passes the secret check and the agent can name it in
   its `action_request`.

## Consequences

- The agent finds "the Lumen group" by its name or its project and asks for the owner's card as before. Who may be sent
  to, and who approves, is unchanged.
- A group's members choose its title, so a title can read like another group's. The owner's card still names the group
  and tells alike-named groups apart by project (`name_project`, ADR-0254), and nothing is sent without that card.
