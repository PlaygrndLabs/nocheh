# ADR-0179: A model list's page size passes the privacy guard

<status>
Accepted on 2026-10-27. Extends
[ADR-0172](0172-provider-model-lists-pass-the-guard.md) after the owner moved
every part to Anthropic models.
</status>

<context>
ADR-0172 lets a bare `GET .../models` through the privacy guard. Against
Anthropic, Hermes asks for the list as `GET /v1/models?limit=N`. The guard
refuses any query string, so this request was refused on every turn.
</context>

<decision>
- A `GET .../models` whose whole query is `limit=` followed by up to four
  digits, with no body, passes without guarding like the bare list.
- Any other query parameter or value, such as a cursor or text, is refused
  as before.
</decision>

<consequences>
- Turns on Anthropic no longer log a refusal for the model list.
- A digit-only page size carries no conversation content.
