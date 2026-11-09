# ADR-0223: Answering a suggestion card does not pause long-term memory

<status>
Accepted on 2026-11-09. The owner pressed Remember on a project card, and a
group reply made in the next minute had no long-term memory. Amends
[ADR-0149](0149-only-owner-changes-hold-honcho.md).
</status>

<context>
ADR-0149 pauses turn-start Honcho context and `nocheh_memory_recall` after
every owner command, until a correction sweep at that command's epoch or later
finishes. The sweep checks every written receipt, and the pause has no time
limit. In the reported case it lasted about 90 seconds. It grows with the
archive and restarts when another epoch lands.

The sweep rebuilds a session only when one of its receipts no longer passes
validation. Validation checks the source's learning consent, readability,
retirement, space and audience, its latest revision, the interpretations and
guarded copies it depends on, and whether its subject and speaker entities are
still active. Answering a suggestion card (Remember or Not this) only adds an
active entity, its project and its bindings, and changes the card's status.
Renaming a person changes only a name. Neither can make a receipt fail
validation, so the sweep after them rebuilds nothing. The pause cost answer
quality and protected nothing.
</context>

<decision>

- An owner command records whether it holds memory. Every command holds by
  default, so any new command starts out safe.
- Answering a suggestion card and renaming a person do not hold.
- Every other owner command still holds memory until its sweep ends, for
  example retiring a message, withdrawing learning consent, merging two
  entities, or changing sharing, fact access or projects.

</decision>

<consequences>
Replies keep long-term memory after the owner answers Waiting cards. Those
commands still advance the guard epoch. A reply already running when one
commits is retried under the new epoch, as before. A command that later gains
an effect on receipt validity must start holding memory again.
</consequences>
