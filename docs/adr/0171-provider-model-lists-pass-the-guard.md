# ADR-0171: A provider's bare model list passes the privacy guard

<status>
Accepted on 2026-10-26, when the owner said "yes for all" to fixing the
background requests the privacy guard refuses. The refusals were recorded
after the release test rerun.
</status>

<context>
Every model request from Hermes is sent through the privacy guard. A request
the guard cannot inspect is refused: one with a query string, or one without
a JSON body. Hermes asks the provider for its model list, `GET .../models`,
twice on every turn to learn the model's context length. Each of those asks
was refused, four refusals per turn, so Hermes fell back to its own
defaults. The guard also refuses two DNS-over-HTTPS lookups when Hermes
starts. Those have a query string.
</context>

<decision>
- A `GET` whose path ends in `/models`, with no query string and no body, is
  sent without guarding. It carries no conversation content.
- A model detail path such as `.../models/<id>`, any query string, any body,
  and any other method or path are guarded or refused exactly as before.
- The startup DNS-over-HTTPS lookups stay refused, because their query names
  a host. Refusing them has no visible effect.
</decision>

<consequences>
- Hermes learns the provider's real model information, and turns no longer
  log four refusals each.
- The guard still sees every request that can carry content.
