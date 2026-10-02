# ADR-0087: Hand background capacity to a live waiting callback

<status>
Accepted implementation decision for the authorized MVP release work.
Supersedes [0085](0085-fair-background-workflow-admission.md) on retaining retry
ordering hints. Retains [0080](0080-reply-admission-and-honcho-derivation.md)'s
operation cap and reserved foreground capacity.
</status>

<decision>
The workflow process may retain one background callback for up to one second
while another operation holds capacity. When capacity becomes available, the
running operation hands it directly to that callback. New background callbacks
cannot overtake the retained callback. Overflow or timeout returns the existing
Inngest waiting observation and leaves no reservation behind.

Waiting borrows no database connection and performs no domain effect. At most
two domain operations and one waiting callback occupy the four-worker pipeline,
leaving a worker available for foreground admission. Foreground work bypasses
the background wait subject to the existing two-operation cap. Exceptions release
capacity, and a timed-out callback cannot start later.

Inngest owns durable scheduling and retries. Domain operations revalidate their
ordinary ownership, receipt and authorization fences when admitted. Process
restart discards only callbacks; durable identities and receipts are preserved.
</decision>

<consequences>
An idle slot is not reserved for an earlier callback whose scheduled retry has
not arrived. This removes the head-of-line delay from historical retry hints.
Fairness applies to the live retained callback; this does not promise a global
FIFO order across sleeping Inngest steps or a maximum model duration. The bounded
handoff can occupy one SDK worker briefly without taking all foreground capacity.
</consequences>
