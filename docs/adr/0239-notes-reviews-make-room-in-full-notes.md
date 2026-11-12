# ADR-0239: Notes reviews make room in full notes

<status>
Accepted on 2026-11-12 as a bug fix: memory-notes reviews saved nothing once a
chat's Hermes native notes were nearly full. Extends
[ADR-0124](0124-native-review-once-per-source.md); keeps
[ADR-0097](0097-durable-native-review-handoff.md) and
[ADR-0183](0183-failed-native-review-without-effect-runs-again.md).
</status>

<context>
- Nocheh runs each memory-notes review through Hermes's background review
  (`spawn_background_review_thread`). Hermes treats a background review that no
  person asked for as unattended: it may add a note, but a change to a note or its
  removal (`patch`, `remove`, or a batch holding either) is staged in the
  profile's `pending/memory/` folder for a person to approve with
  `/memory pending`. Hermes's own `/refine` passes `explicit=True`, which marks
  the review as asked for and lets it make those changes.
- Nocheh passed no `explicit`, so its reviews were unattended. No person can
  approve a staged change there, and `pending/` is not one of an isolated turn's
  mounted data folders (`services/hermes/isolated_profile.py`), so the staged
  change went with the turn's container.
- Notes have a size limit (Settings › Assistant). Near it, an add fails, the
  model sends the add with a remove in one batch as the memory tool tells it to,
  and that batch is staged and lost. The review still ended `done`, so it did not
  run again, and later reviews that needed room failed the same way.
- Hermes's separate approval switch, `memory.write_approval`, stages every note
  write, in reply turns too. It is off by default, and Nocheh's settings cannot
  turn it on, but nothing in Nocheh kept it off.
</context>

<decision>
- `native_review` passes `explicit=True`: Nocheh asks for each notes review, so
  Hermes runs it as a requested review that may change or remove notes to make
  room, as a reply turn already may.
- Every profile's `config.yaml` sets `memory.write_approval: false`, kept by
  Nocheh like `memory.provider`. No note write waits for an approval no one can
  give.
- `pending/` stays unmounted; nothing writes there.
</decision>

<consequences>
- A review can now change or remove a note that no person read first. Notes are
  derived from the owned archive, reviews are asked to cite their sources, and
  reply turns could already do this.
- Reviews that ended `done` with their change lost are not run again.
- Checks: a real review in its own process, against a scripted local model
  server whose add is refused on full notes and then sent again with a remove,
  saves the new note, with no `pending/` folder
  ([check](../../services/hermes/test_native_memory.py)); the profile setting
  stays off ([check](../../services/hermes/test_profile_config.py)).
</consequences>
