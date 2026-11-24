# ADR-0299: Hide unused facts after a set number of days, off by default

<status>
Accepted on 2026-11-24. The owner asked: "Retire old facts that not used for custom config day for
example if fact not use in past 180 day retire it", "dont remove it just keep it hide", and chose
that a fact counts as used when either a reply read it or a chat said it again. The owner kept both
clean-ups, each off by default. Builds on [ADR-0298](0298-retire-old-facts.md) (hidden facts and
"Bring back").
</status>

## Context

- Honcho's dreams (ADR-0298) hide facts that newer ones replaced. They never hide a fact that is
  simply never needed again.
- Honcho keeps no record of when a fact was read. Nocheh knows which facts each reply read: the
  numbered facts of a context block and the facts a recall lists.
- Honcho records the messages a fact cites. When a chat says a fact again in the same session,
  Honcho does not write a new fact: it adds the new message to the old fact's citations. In another
  session, it writes a new fact there.
- A memory wall holds copies of a person's facts (`internal_metadata.copied_from`). A group reads
  the copy, not the original.

## Decision

1. **One owner setting, off by default.** `memory_clean_up.hide_unused_days` in Nocheh's control
   database is either off (`NULL`) or 30 to 3650 days. It is changed in its own dialog on Memory ›
   Long-term › Status and limits ("Hide unused facts"), and the change applies at once.
2. **Use is tracked all the time.** Each reply marks the facts it read, in the background, through
   the plugin route `POST /nocheh/used`. The route writes `internal_metadata.nocheh_used_at`, at most
   once a day per fact. A failure is logged and never slows a reply.
3. **A fact's last activity** is the newest of: when it was learned, when a reply last read it, and
   the newest message it cites. A fact and its wall copies are one family, and the family counts
   its newest activity. A group reading the copy keeps the person's fact, and the other way round.
4. **The sweep** checks every hour and runs at most once a day, claimed in one row so only one
   process runs it. It calls `POST /nocheh/hide-unused` with `before` = now minus the set days, 200
   families a call, up to 50 calls. Each family with no activity since then is hidden whole, with
   reason `unused`, using the same far-future `deleted_at` as ADR-0298. The plugin refuses a
   `before` later than 30 days ago. A failed sweep is tried again at the next hourly check.
5. **No hiding before enough tracking.** `tracking_since` is when Nocheh began tracking use. The
   sweep hides nothing until the set number of days has passed since then, so turning the rule on
   never hides facts only because older reads were not recorded.
6. **Bringing a fact back counts as a use**, so the rule doesn't hide it again the next day.

## Consequences

- No model calls: the sweep is one query per batch in Honcho's database.
- Every reply that reads facts makes one more small call to Honcho, which writes at most once a
  day per fact.
- A fact said again in another chat is learned again there, so the old copy in the first chat can
  still be hidden. The fact itself stays known.
- A fact only Honcho's own prose used (the owner's block falling back to prose) isn't marked used.
- Hidden facts show under "Hidden facts" with "Not used for the set days", and Bring back restores
  them with their wall copies.
- Checks: `services/honcho/test_provenance.py`, `test/memory-engine.test.ts`,
  `test/store-memory-clean-up.test.ts`. The plugin's SQL was run against Postgres 16 with a
  synthetic family (a copy read recently, a fact cited recently, a fact learned recently).
