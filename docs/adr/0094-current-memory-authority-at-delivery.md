<decision>

# 0094 — Recheck the exact memory grant at delivery

<context>

[0093](0093-atomic-memory-approval-followups.md) atomically binds a memory grant
and its follow-up. Automatic entity claims can change without a global guard
epoch change. The action's own guarded copy can consequently remain current
while its approved fact or memory grant has become unusable.

</context>

<choice>

Extend [0089](0089-physical-telegram-delivery-boundary.md): a trusted memory
follow-up must retain its exact request, grant, source, audience, binding and
wording links. Require the active, unexpired grant, current fact revision and
matching guarded representation before action admission and at every physical
delivery check. Suspend a grant whose fact or representation changed, and
cancel an unstarted action that no longer has delivery authority.

Recognize memory follow-ups through their existing trusted proposal provenance.
Ordinary exact actions and content-free owner notifications retain their own
authority. There is no new credential, schema or retry identity.

Observation of an existing native receipt remains separate from permission to
send. A confirmed delivery can still reconcile after a fact changes or access
is revoked; that path performs no new transmission.

</choice>

<consequences>

Keeping an immutable approved action alone does not preserve expired or
superseded memory authority. Additional reads occur only for memory follow-ups;
all Telegram chunks use the existing physical authorization callback.

</consequences>

</decision>
