# ADR-0259: Honcho's vector reconciler retries each workspace bound

<status>
Accepted on 2026-11-17 after a long-term memory rebuild on a running installation
left 46 of 909 Honcho message embeddings pending for good, so Honcho's message
search by meaning missed those messages. Extends the Honcho provider gateway
boundary of [ADR-0033](0033-guarded-projections-and-honcho-memory.md) and
[ADR-0150](0150-honcho-recall-checks-take-reply-priority.md); keeps the
preparation rules of [ADR-0174](0174-memory-preparation-outages-are-retried.md).
</status>

<context>
Every Honcho call to the provider gateway names the memory workspace it works
for. The gateway asks the archive to prepare the request for that workspace, and
the archive refuses any workspace that is not the current one. Honcho's own
process does not choose it: the API binds the workspace of the request path, and
the deriver binds the workspace named by the work unit it runs. A call with no
workspace bound is refused inside Honcho (`honcho_workspace_required`) and never
leaves it.

Honcho writes a message's embedding rows as pending and embeds them right after
the request in a background task. When that task is shed (too many at once),
fails, or is cut by a restart, Honcho's vector reconciler is the only retry. It
runs as one deriver work unit (`reconciler:sync_vectors`) that names no
workspace, because one batch holds pending rows of every workspace. So each of
its embedding calls was refused; a row's attempts count up to Honcho's limit of
20, after which Honcho marks it `failed`. A large rebuild sheds many first
embeddings, so those messages were never found by search by meaning. Documents
are embedded in the deriver's own bound work and were not affected.

The reconciler also sends up to 50 messages' rows in one embeddings request,
while the gateway accepts at most 100 inputs and 128 KiB of text per request.
A batch of long messages (forwards, transcripts, file text) was refused whole,
so binding the workspace alone would still leave such a backlog pending.
</context>

<decision>

- `services/honcho/boundary.py` `bind_reconciler` wraps the reconciler's two
  batch sync steps (`_sync_message_embeddings`, `_sync_documents`). Each batch is
  split by the rows' `workspace_name`, and each workspace's rows run through
  Honcho's own step with that workspace bound; the counts are added up. The deriver applies it at start
  (`services/honcho/run.py`). Honcho's code is unchanged.
- Each workspace's rows go in parts that fit one request the gateway accepts
  (`reconciler_parts`: at most 100 rows, the bound of `meter.validate`, and
  120 KiB of text, leaving 8 KiB of its 128 KiB for the archive's preparation,
  which can mask a text a little longer before the gateway checks it again). A
  message's rows stay together and in order; a message larger than one request
  goes alone and the gateway decides.
- A row with no workspace runs unbound and still fails closed.
- Nothing else changes at the gateway: the request keeps the deriver's
  background priority, the archive still prepares and secret-checks every text,
  and a workspace it refuses (an earlier one) fails for its own rows only.

</decision>

<consequences>

- Message embeddings whose first attempt was shed or failed are embedded on a
  later reconciler run, about every five minutes, after Honcho's 10-minute wait
  between attempts.
- The trust is the same as the deriver's: the workspace comes from Honcho's own
  database rows, as a work unit's does, and the archive decides what may be
  sent.
- Rows that already reached `failed` are never retried by Honcho. On a
  development install they can be set back to `pending` with their attempts
  reset; the reconciler then embeds them.
- A batch costs one embeddings request per workspace and part instead of one
  for the batch; an installation has one current workspace, and most parts hold
  the whole batch. Parts run one after another in the batch's transaction, so a
  batch of many long messages takes longer, and during an archive outage each
  part waits out its own retries; the deriver's claim heartbeat keeps the work
  unit while it runs.
- A refused part fails only its own rows.

</consequences>
