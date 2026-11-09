# ADR-0220: Limited memory is the agent's context, never added reply text

<status>
Accepted on 2026-11-09 after a group reply ended with the fixed line "Memory
is limited; current context, native notes and archive search remain
available." The owner asked what it meant. Amends the reply side of
[ADR-0044](0044-automatic-honcho-context.md),
[ADR-0114](0114-event-driven-honcho-context.md) and
[ADR-0148](0148-honcho-reads-wait-for-epoch-correction.md).
</status>

<context>
When a turn's Honcho context came back limited, the Hermes turn wrapper added
that English sentence to the agent's finished answer. The agent never wrote
it, so it ignored the reply's language and the question, and it showed an
internal status to everyone in the chat, members included.

In the reported case, the owner pressed Remember on a suggestion card while
the reply was running. That owner change advanced the guard epoch, so the
running attempt stopped and a new attempt started. Long-term memory then
stayed paused until the epoch's correction sweep finished, about 90 seconds
later (ADR-0149). The new attempt answered in that window. Nothing failed, and
the reply needed no long-term memory.
</context>

<decision>

- A reply is the agent's own final text. Nocheh adds nothing to it when memory
  is limited, syncing or being corrected.
- The agent still receives the memory status, with `limited_memory`,
  `syncing` and the note, as it did before. Hermes decides whether the status
  matters for the answer and how to say so, in the asker's language.
- The owner sees memory status in the dashboard, as before.

</decision>

<consequences>
A reply no longer carries a fixed English line that the agent did not choose.
A reply made while memory is limited can still say that it lacks long-term
memory, but only when the agent judges that it matters. The memory pause
after an owner change is unchanged.
</consequences>
