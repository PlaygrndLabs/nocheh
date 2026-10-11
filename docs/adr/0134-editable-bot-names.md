# ADR-0134: The names that address Nocheh are one editable list

<status>
Accepted on 2026-10-11. Amends [ADR-0133](0133-group-replies-when-addressed.md):
`TELEGRAM_BOT_NAMES` replaces its `TELEGRAM_GROUP_NAMES` extra-name setting.
</status>

<context>
A live group message opening with “Nocheh,” got no reply: the bot's Telegram
display name differed and no extra names were set. Making “Nocheh” and
“نوچه” fixed names solved that, but the owner wants the names configurable
from the dashboard.
</context>

<decision>

- `TELEGRAM_BOT_NAMES` holds every name, besides the display name, that
  addresses the bot when it opens a group message: up to ten comma-separated
  names of up to 32 characters. Its default is `Nocheh,نوچه`, so Settings ›
  Telegram access shows both names prefilled and the owner can change, add,
  or remove any of them.
- An empty list means no names; Compose passes it with `${VAR-default}` so an
  owner's empty value is not replaced by the default. The Hermes gateway also
  uses the default when the variable is absent.
- The bot's display name and @username always address it and are not part of
  the list.

</decision>

<consequences>
- The setting has a new key, so an installation's saved empty
  `TELEGRAM_GROUP_NAMES` does not hide the defaults; the old key is ignored.
- Name changes take effect when Settings are applied and Hermes restarts.
</consequences>
