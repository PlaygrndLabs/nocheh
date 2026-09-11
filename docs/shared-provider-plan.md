# Share one ChatGPT login through CLIProxyAPI

Accepted plan: ADR-0035. `TASK.md` records actual completion and evidence.

1. **Contract:** record the shared authentication, retry, speech and monitoring
   boundaries. Keep the existing native Hermes route available only as an inactive
   rollback until shared-provider acceptance passes.
2. **Provider service:** promote the pinned CLIProxyAPI build from the Honcho
   experiment into the local Nocheh stack. CLIProxyAPI is the sole OAuth writer
   and refresh owner. Hermes, Honcho and trusted preparation use distinct internal
   client keys. A fresh proxy device login replaces, rather than copies, Hermes's
   login at cutover.
3. **Hermes and voice:** route every Hermes reasoning path through the guarded
   OpenAI-compatible proxy. Keep `codex-asr` as the speech client; a trusted speech
   boundary reads the proxy's current access token without receiving the refresh
   token or writing the auth store.
4. **Honcho:** use the same reasoning proxy while retaining the existing Nocheh
   preparation gateway, audience generations, durable receipts and separately
   capped paid embeddings. Provider retries must return through current-revision
   guarding before another model attempt.
5. **Monitoring and cutover:** run pinned CPA Manager Plus Full Mode as a separate
   service, proxy it behind the Nocheh owner dashboard, verify shared reasoning,
   refresh, transcription, monitoring and recovery, then deactivate the old Hermes
   login. Honcho attachment still requires its independent live embedding and
   ingestion/recall gates.

Each phase ends with relevant checks, an AST-only Graphify refresh when code has
changed, a scoped commit, and automatic continuation. Local Docker Compose remains
the acceptance target. Missing live credentials or provider capacity remain pending
checks and do not prevent independent implementation work.

