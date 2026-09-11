# ADR-0028: Isolate managed turns behind the native TUI

Status: accepted implementation decision under ADR-0027. Date: 2026-09-08.

The pinned Hermes TUI supplies the browser terminal, session navigation and display.
Its persistent gateway must not own model credentials or run unrestricted agents:
Nocheh archive capabilities bind once per process, and subscription refresh has one
supervisor. Telegram and browser turns therefore use the same isolated Python child.
A profile lock prevents simultaneous writers to its native memory and conversation.

A small pinned TUI patch captures the resolved composer text before slash-command,
file or shell interpretation. Inputs have stable identities; attachments are copied
into the owned archive before model execution. The native gateway cannot construct
an agent through a second path. Local commands are observed inputs without a model
run. Resubmission is a new observation, never an edit to the original source.

PostgreSQL claims each input once. A 60-second lease, renewed every 10 seconds,
marks abandoned work interrupted without rerunning it. Result receipts are fsynced
locally before publication and reconciled after an outage. Late results remain
separate evidence and do not erase an interrupted execution status. Reconnects reuse
native PTYs and stable stored session IDs; channels are bound to a canonical profile.
Explicit resume IDs must exist in that profile. An unpersisted draft may start fresh.

The supervisor gives each child a short-lived access token; refresh tokens stay in
the supervisor's native store. Every model attempt retains the existing guard and
transport restrictions. Required guarding rejects opaque image context; an explicitly
trusted route may receive archived original images. Voice uses the existing automatic
transcription service. Bounded UTF-8 attachments become context; other binary files
remain retrievable without claiming text extraction. Original bytes are never replaced.

This phase keeps the existing memory, session search, archive and action-proposal
tools. Native shell interpolation, arbitrary gateway RPCs, local wake-word models,
auto-continuation and the unmanaged WebSocket agent remain disabled. Broader tools
require phase 5's independent execution and external-action controls. This adapter
is specific to the pinned Hermes transport; it is not a general plugin marketplace.
