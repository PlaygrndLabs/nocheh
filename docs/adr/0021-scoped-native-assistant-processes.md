# ADR-0021: Isolate native assistant profiles and bind archive capabilities

Accepted, 2026-09-07. Phase 6 implementation choice; live Telegram acceptance is
still pending credentials. This does not declare the rebuild released.

Use Hermes's native Telegram adapter for polling, event decoding, media handling,
formatting and sending. Nocheh's worker dispatches committed live updates to that
adapter; durable receipts stay open across its delayed text/media tasks. Imports,
replay, edits, callbacks and unselected conversations are archived without replies.

Use native profile route matching to select a distinct profile for each selected
group and the owner DM. Run each native AIAgent turn in a fresh process with that
profile's HERMES_HOME, built-in memory and SessionDB. Persist the native session
cursor across turns. The supervisor remains the sole OAuth refresh owner; children
receive only the current access token, not a copied refresh-token store.

Expose exactly memory, session_search, nocheh_archive_search, nocheh_archive_read
and nocheh_action_request. Disable native deferred tool discovery. Reject unexpected
tools. Disable session_search's explicit cross-profile opens and its cross-profile
fallback when a session ID is absent. Owner cross-chat retrieval uses the owned
archive, whose server verifies a signed capability. Group capabilities name one
scope; owner DM capabilities permit archive-wide reads. Turn capabilities also bind
the source event for action proposals. Existing read-only scope tokens cannot propose.

The native adapter sends final text directly through its own send implementation
and Nocheh's durable outbound journal. Do not invoke implicit model-directed local
file delivery, TTS, arbitrary execution/network tools, or native admin menus. This
prevents a generated MEDIA/path directive from exposing another profile's files.
No new reasoning loop or memory implementation is introduced.

Transcribe archived audio before assistant dispatch. Store transcripts separately
with input hashes and pinned bridge provenance, and preserve their exact content.
Record quota/failure states and retry after a delay. An uncertain dispatch response
reuses its receipt identity. An orphaned dispatch or external-action intent after
restart is ambiguous and is never automatically resent.

For external Telegram messages, a scoped tool can only propose immutable text and
destination. Only a captured, live, typed owner DM command can approve or reject it.
The worker executes approved requests using native Telegram sending and durable
receipts. Other external integrations remain unavailable until they have equivalent
approval enforcement. All request/decision/delivery observations remain in the
owned archive for export; historical import never re-executes them.
