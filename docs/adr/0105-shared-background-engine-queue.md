# ADR-0105: Queue background workflow steps in one shared Inngest concurrency key

<status>
Accepted implementation decision. Extends
[0080](0080-reply-admission-and-honcho-derivation.md) and
[0087](0087-live-background-admission-handoff.md). Reply admission, the
worker's in-process background slot and its live one-second handoff are
unchanged.
</status>

<context>
The pre-MVP installation's PostgreSQL volume reached about 37 GB, 35 GB of it
the Inngest database: 27 GB of `spans`, 4.8 GB of `history` and 3.3 GB of
`traces`. Nocheh never reads these tables for receipts or recovery; they serve
Inngest inspection and backups. Honcho and native memory review produced 99.5%
of the 13.4 million spans, while Telegram produced about 5,600. A memory review
run averaged 1,482 spans.

A sample of step outputs showed why: about 86% of honcho and memory review
steps returned `waiting/admission/receipt_pending`. The pipeline worker admits
all background families to one slot. Every queued background run therefore ran
a step every ten seconds only to learn that the slot was busy, and each such
step, plus the sleep that followed it, persisted several span, history and
trace rows. A Honcho source waiting for its generation to become ready also
polled every second, for hours while a generation was building.
</context>

<decision>
Pipeline background families, meaning every storage family outside the
reply-foreground set, register one shared Inngest concurrency limit: limit 1,
key `"nocheh-pipeline-background"`, environment scope. Inngest holds their
steps in its queue until the key is free, so a waiting run executes no step and
writes no telemetry while it waits. Sleeping runs hold no slot. Foreground
families (preparation, Telegram, browser, schedules and approved actions) have
no shared limit and keep their reserved reply capacity.

The in-process admission bound stays as the authoritative guard for the
worker's pool, including when a foreground step is active. A Honcho source
waiting for an unready generation now rechecks every 30 seconds instead of
every second.
</decision>

<consequences>
In a synthetic probe against the pinned local Inngest, 16 contending
background runs plus one reply needed 105 wait polls and 888 spans under the
previous registration, and 0 polls and 153 spans with the shared key. The batch
finished in 29 instead of 137 seconds, the reply's latency was unchanged, and
background execution never exceeded one at a time. Long real waits save
proportionally more.

Existing rows are not removed by this decision. Inngest does not expire
PostgreSQL events, runs or traces, so a bounded retention policy remains a
separate, owner-approved step. A Honcho source can start up to 30 seconds
after its generation becomes ready. A background step admitted while a
foreground step runs can still take the existing ten-second wait, now for at
most one run at a time.
</consequences>
