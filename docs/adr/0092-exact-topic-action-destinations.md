<decision>

# 0092 — Preserve topic identity in approved Telegram actions

<context>

[0029](0029-controlled-tool-execution.md) binds approval to an exact effect, and
[0089](0089-physical-telegram-delivery-boundary.md) checks every physical send.
The source conversation can contain a topic, so a chat ID alone cannot identify
the destination of a follow-up or a request to send in the current conversation.

</context>

<choice>

Store a topic destination as the existing concrete space identifier
`CHAT_ID/topic/THREAD_ID`. Include the whole destination in the proposal identity,
fingerprint, approval and delivery authorization. Resolve `current` from the
authenticated source space. Retain existing numeric destinations and immutable
approvals without widening or rewriting them.

The native boundary separates the validated destination into Telegram's chat ID
and Hermes's thread metadata only when sending. Its physical validator still
compares every request with the full approved audience. A missing non-General
topic cannot fall back to General. Hermes's pinned General convention omits
`message_thread_id` for thread 1; that omission is valid only for General.

</choice>

<consequences>

Owner review and receipts retain the actual topic. Trusted memory follow-ups use
the same representation and send boundary. Existing approval fingerprints and
uncertain-delivery receipts remain immutable. Synthetic coverage exercises the
real PostgreSQL action path and pinned native adapter, including restart replay
and deleted-topic rejection; it does not establish live delivery acceptance.

</consequences>

</decision>
