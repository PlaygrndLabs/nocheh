<decision>

# 0089 — Recheck the actual Telegram send

<context>

The audience and receipt boundaries in [0029](0029-controlled-tool-execution.md)
and [0030](0030-configurable-space-memory.md) apply to every delivered part of a
response. Hermes formats, splits and retries inside one high-level `send` call.
A check before that call cannot see a later topic fallback or a revocation
between chunks. Native fallback behavior is not audience authority.

</context>

<choice>

Bind an outbound validator to the native send's context. The durable capture
transport invokes it on the actual method and parameters before every outbound
journal admission or transmission. Conversation replies bind the original chat
and topic, current delivery policy, and cancellation. Approved actions bind their
exact destination and current action policy. Unsupported method or routing
changes fail closed. The scope is reset after the send.

Keep Hermes's native formatting and safe same-audience fallbacks. Reject the
native fallback from a missing topic to the group's General conversation. Recheck
authority for later chunks and internal retries. Keep the durable send receipts;
when some delivery may already have happened, interruption remains uncertain and
cannot cause an automatic resend or a claim that the complete response was cancelled.

</choice>

<consequences>

This extends the existing audience/delivery boundary without replacing the native
adapter. Each physical request can incur a fresh internal policy lookup. As with
any external effect, a revocation cannot retract a request already transmitted.
Synthetic tests exercise the actual pinned native adapter and PTB transport with
Bot API errors; provider reasoning and real Telegram acceptance remain separate.

</consequences>

</decision>
