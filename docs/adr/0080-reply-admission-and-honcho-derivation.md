# 0080 — Reserve reply admission and parallelize Honcho derivation

Status: Accepted

## Context

A same-topic owner question waited several minutes before native execution, while
Honcho generation observers repeatedly waited for a single derivation worker.
The topic generation had acknowledged ingestion but was not ready until Honcho's
queue drained much later. A separate General turn hit the native process timeout
before delivery and recovered on its second attempt. These are distinct stages.

## Decision

The two-slot storage workflow admission keeps one slot available for preparation,
Telegram, browser, schedule, and approved action work. Honcho and memory review
share the other slot when both are free. A busy background operation waits ten
seconds before retrying; foreground work retains the short retry. The admission
cap and database pool cap do not increase.

New local Honcho setup configures two workers in the existing single deriver
service so independent workspace work units can advance concurrently. This does
not change model routing, the embedding dollar cap, the subscription request
limit, source consent, audience isolation, or the requirement that the current
generation's queue empty before its first context snapshot is usable. Existing
installations need an explicit deriver recreation to use the new worker setting.

## Consequences

Foreground admission can no longer be occupied entirely by memory work. Under
continuous foreground traffic, memory work can progress in the remaining slot,
subject to the existing bounded operation and provider limits. A ready snapshot
still reports limited memory truthfully until the current authorized generation
has passed its normal queue and guard checks. Runtime activation and live latency
validation remain separate from this code change.
