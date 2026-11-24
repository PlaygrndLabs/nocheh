# ADR-0296: A backup reply model

<status>
Accepted on 2026-11-24. The owner asked for it after the comparison with another personal
assistant ("Backup model"). Widens the security broker's rule that admits only the configured
reply model by one model.
</status>

## Context

A reply turn whose model fails is retried on the same model, with growing waits. During a
provider outage of one model every reply waits for it. Hermes can switch a run to the next
model of a fallback chain when the current one cannot answer (`fallback_model` on its agent),
but Nocheh passed none, and the broker refused any model other than the reply model.

## Decision

1. **One optional setting.** Settings › Models has "Backup for replies"
   (`NOCHEH_REPLY_BACKUP_MODEL`), empty by default. It names a model on the replies provider;
   it must differ from the replies model, and a replies provider must be set.
2. **The broker admits it.** Compose passes it as `NOCHEH_BACKUP_MODEL` to the security
   service and Hermes. The broker admits a model request that names the reply model or the
   backup model, and nothing else; the turn binding carries `backup_model`.
3. **Hermes switches by itself.** The launcher takes `backup_model` from the binding only.
   The turn's agent gets a one-entry fallback chain on the same broker route, provider and API
   mode, so the backup call is guarded, checked and recorded like any other.
4. **Usage shows it.** A turn that ended on the backup model is recorded under that model,
   so the Usage page shows its calls and cost.

## Consequences

- Anthropic only stays true: the backup is a model on the same provider.
- A failure that hits every model of the provider still fails the turn, and the usual
  retry and problem notice follow.
- The profile YAML's `fallback_models` stays empty; the chain is set per turn, from the binding.
