# ADR-0152: The owner's instruction texts travel with each runtime call

<status>
Accepted on 2026-10-17.
</status>

<context>
The owner asked that every hard coded text be editable from the dashboard. The
instruction texts Nocheh's code gives models were fixed strings in two places:
Hermes ran the reply rules, the remembered-facts and limited-memory notes, the
native notes review focus, the secret check and the group sharing filter; the
storage service sent the learning instruction to Honcho. Hermes is replaceable,
and turns, reviews, secret checks and sharing filters all start from storage
service runtime calls.
</context>

<decision>

- Defaults stay with the code that runs each text: `services/hermes/prompts.py`
  for the Hermes texts, `src/prompts.ts` for the learning text. The runtime
  reports its defaults through the `prompts.defaults` operation
  (`/internal/manage`, action `prompts`) so the dashboard can show and restore
  them.
- Only the owner's replacements are stored, in the control database
  (`owner_prompts`, one revisioned row) and edited through `/v1/prompts`. A
  text the owner never changed follows the code's default.
- `withPrompts` wraps the runtime call in the storage and security services:
  `run.start`, `memory.review`, `guard.detect` and `memory.filter` carry the
  replacements as `prompts`. Hermes uses a valid replacement or else its
  default. A retried run keeps the texts of its first request; `prompts` is not
  part of a run's identity.
- The learning text must keep `{trigger_id}` and `{citable_ids}`, which Nocheh
  fills in. Evidence, archive-source and attachment labels stay fixed, as do the
  internal prompts of Hermes and Honcho.

</decision>

<consequences>
A change applies from the next call without a restart. A replacement runtime
reports its own defaults and reads `prompts`. If the control database cannot be
read, those runtime calls fail rather than silently ignoring the owner's texts.
An edited secret check that breaks its JSON reply format fails closed, so
messages wait until it is fixed or reset. An original-only reset does not yet
carry the replacements across.
</consequences>
