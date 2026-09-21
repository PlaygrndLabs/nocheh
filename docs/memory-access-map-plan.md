# Unified memory relationship and access map

This plan implements [ADR-0057](adr/0057-memory-relationship-access-map.md) in four
verified increments: contract and durable schema; scoped grants and private review;
owner APIs and the accessible two-dimensional map; then portability and isolated
acceptance. Relationships remain descriptive throughout. Only an active, current
fact grant can add memory to a group or topic.

Acceptance covers owner-wide recall, group and topic isolation, owner-authored group
requests, bounded related-fact suggestions, rejection without a permanent block,
one-time consumption, persistent access, suspension, revocation, delivery receipt
reconciliation, portability, and keyboard/mobile dashboard behavior. Live Honcho
activation and provider cutover are outside this plan.
