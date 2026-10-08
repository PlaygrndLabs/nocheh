# ADR-0107: Run workflow telemetry retention daily

<status>
Accepted implementation decision. Supersedes the hourly interval in
[0106](0106-configurable-workflow-history-retention.md); its setting, scope,
batching and shutdown order are unchanged.
</status>

<context>
Retention is configured in whole days, so an hourly check adds work without
making expiry meaningfully more precise. The owner asked for a daily check.
</context>

<decision>
When retention is enabled, the worker checks once when `nocheh-db` starts and
then every 24 hours.
</decision>

<consequences>
Expired telemetry can remain for up to one extra day before removal. Each daily
pass deletes more rows than an hourly pass would, in the same bounded batches.
</consequences>
