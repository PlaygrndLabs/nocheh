# Review replay

<purpose>

Answers whether Hermes memory-notes reviews (`memory_review`) behave differently on
Anthropic's Messages API than on its OpenAI-compatible chat API, which they used before
prompt caching ([ADR-0199](../../../docs/adr/0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md)),
and whether the thinking setting explains a difference. Live data suggests fewer
reviews make a second model call on the Messages API. It also answers whether reviews
on full notes fail because the review's input budget stops them.

The same stored review inputs run, with the same model and the same Hermes, in up to four
arms (`--arms`, default A, B and C):

- **A**: the OpenAI-compatible chat route, as before prompt caching.
- **B**: the Messages API, as live today. Hermes sends no `thinking` field, so the API's
  default (adaptive thinking) applies.
- **C**: as B, with `assistant_turn.reasoning` returning `{'enabled': False}`. For
  `claude-sonnet-5-5` Hermes then sends `thinking: {type: between_tools}`
  (`agent/anthropic_adapter.py` `_thinking_kwargs`): no thinking before the first answer,
  but thinking between tool calls is still allowed. C is not "thinking off", and C minus A
  is not the effect of thinking as such.
- **D**: as B, with the review's whole-prompt input budget at 48,000 tokens instead of
  the 24,000 `services/hermes/native_memory.py` gives Hermes's review. The budget counts
  every prompt token of every call of a review, cached or not; at about 10,000 tokens a
  call, 24,000 leaves room for three calls.

For each arm, and each arm and kind of source, it reports the share of runs with two or
more model calls, mean calls, the share of runs that changed Hermes native notes
(`MEMORY.md`, `USER.md`), adds, replaces and removes the model asked for, failures,
cost, and the thinking settings each arm actually sent. Per arm it also lists the
operations by name (`patch` and the removed `replace` apart), what Hermes answered the
model's memory writes (applied, staged, or refused and the kind of refusal), failed runs
by cause and whether their notes changed, and the mean prompt tokens per call. Calls are
Hermes's own count, the figure live reports. It compares B and C with A, and D with B,
per source (each source averaged over its repeats) with 10,000 seeded paired bootstrap
resamples, 90% and 95% intervals, and reports how often two A runs of one source agree on
changing the notes, against B and A, C and A, and D and B.

</purpose>

<boundaries>

- The review fragments it sends are stored guarded copies: the fragment texts of
  finished reviews whose guard mode was `on`. Jobs in guard mode `off` are skipped.
- Every run starts with empty notes (`MEMORY.md`, `USER.md`, step 5), unless the
  operator uses step 5's full-notes variant: then every run starts from a copy of the
  owner's current notes, which reach the provider as they do in a live review. The owner's
  own prompt texts are not sent: every run uses the default prompts (step 6), the same
  in every arm.
- It writes nothing to the live stack. The databases are read once with read-only
  SELECTs, and the owner's profile settings are copied. The replay container joins no
  Nocheh network and mounts no live folder. Its inputs are mounted read-only; only its
  output folder is writable.
- Every run works on a copy of the profile template in the container's `/profile`
  (memory only), emptied before and after each run. `results.jsonl` and `calls.jsonl`
  (mode 0600) hold counts, codes and setting names only: no message text, note text,
  tool arguments, keys or provider error bodies.
- The provider key is typed into a shell variable that is not exported, and reaches the
  driver on standard input. It is in no command line, environment or container
  configuration, and it is never printed or written. Only the relay holds it. The review
  process holds only its run's stand-in credential.

</boundaries>

<how_it_works>

A throwaway container from the Hermes image runs `driver.py`, which starts `relay.py` on
127.0.0.1:8786. With `--add-host nocheh-security:127.0.0.1`, Hermes's isolated-turn code
reaches the relay exactly as it reaches Nocheh's security broker
(`services/hermes/security_transport.py`).

Each run is the live review subprocess, `python -m services.hermes.assistant_turn`
(arms C and D through a one-line wrapper that patches `reasoning`, or wraps Hermes's
`spawn_background_review_thread` to set the budget, and calls `main()`), with the
body `review_worker._review` builds in isolated mode plus the `model_context_length` the
security launcher adds, and the launcher's environment: `HERMES_HOME=/profile`,
`HOME=/tmp/home` (not made in advance), `NOCHEH_ISOLATED_TURN=1`, `GUARD_URL` and
`ARCHIVE_URL` at the broker address, `GUARD_MODE=on` (the turn's default), and the
image's own `PATH`, `PYTHONPATH`, `LANG` and `LD_LIBRARY_PATH`. Hermes writes both homes
into the system prompt, so every run uses these same paths and nothing in what the model
is sent names the run, arm or repeat; B's and C's system prompts are identical. The
model routes keep the broker's own address, the only one Hermes accepts.

Before a run the driver empties `/profile` and removes `/tmp/home`, copies the template
into `/profile`, removes whole note entries (`§`-delimited) that cite the source event
(`nocheh:event:<id>`), so the run starts without the notes the original review wrote,
calls `isolated_profile.prepare`, and computes the preferences as `_review` does, with
the template as the policy root (`NOCHEH_RUNTIME_HOME`, as live names the state root).
Live, the turn does not see the policy file either. After the run it empties both again.

The relay answers:

- `POST /v1/guard` and `POST /v1/context/prepare` with their input unchanged, in the
  broker's and the stores' response shapes. The guard route still refuses what the
  broker's `inspectRequest` refuses, and refuses (403 `replay_destination_denied`, the
  host logged) any destination other than the broker's address: live, the turn's
  network allows nothing else; this container has a network.
- `POST /v1/chat/completions` and `POST /anthropic/v1/messages` as the broker does:
  the same request policy (refused fields, hosted tools, opaque context, earlier
  reasoning dropped from assistant messages), the same model check, headers
  (`anthropic-version`, only Hermes's two `anthropic-beta` values, `user-agent`), and
  answer to a refused provider call (401, 403 and 429 passed on, 503 otherwise, with the
  provider's status but never its body).
- `GET .../models`, which Hermes asks for on each run, with the broker's 403.
  Anything else gets 404 and a line in the log.

Per provider call it logs the run, route, status, stop reason, the type of an error
event inside a stream that answered 200, tool calls and their names, `(action, target)`
of each memory operation (Hermes 0.23's `operations` list or the legacy single action),
usage, thinking blocks and their characters, the thinking and effort settings sent,
latency, and where the memory evidence block sat in the request at `/v1/guard`
(`first_block`, `separate_message`, `other` or `absent`).

Per run, `results.jsonl` holds the source key's first 8 characters, kind, arm, repeat,
state, failure codes, `hermes_calls` (Hermes's own `api_calls`, one per loop iteration
however often a call was retried: the count behind "2+ calls", as live reports it),
`calls` (completed calls the relay forwarded on the arm's route: 200, a stop reason, no
error inside the stream; used only when Hermes reports no count), calls that did not
complete, errors inside streams, each call's counts, memory operations, what Hermes
answered them (as a kind, read from the tool results the next call carries, so the last
call's results are not seen), note entries
before and after, whether each notes file changed, staged (held) memory changes in
`pending/memory/`, tokens, cost, whether the cost is not fully known, and seconds. The
summary counts the runs where the relay's and Hermes's counts differ.

Cost is estimated at $2 per million input tokens, $10 output, $0.20 cache reads and
$2.50 cache writes. The driver launches no run once the spend so far plus the mean cost
of a run so far would pass `--budget-dollars` (default 15). The cap counts every run
recorded in the `--out` folder, also across invocations with `--resume`, but not other
folders. When a run ends, the driver waits up to 130 s for a call the relay is still
reading from the provider, which is billed even if the review process was stopped. It
launches no more runs when a run's cost is not fully known: a call still in flight after
that wait, or a 200 answer whose usage the relay could not read.

Differences from live, by design:

- No secret check or context preparation runs. The guarded fragments pass unchanged,
  and the model's own output is not masked.
- Every run uses the default prompt texts; live, a review uses any the owner replaced.
- Every run starts with empty notes, as a profile does at the start of each guard epoch
  (Hermes native notes stay in the earlier epoch's profile, ADR-0163); live, notes grow
  within an epoch. Full notes push a review into batches that remove or patch entries to
  make room, which take more calls and can use up the review's input budget; step 5's
  full-notes variant measures that case.
- Live, a turn container's `/profile` is temporary apart from its mounted folders, so
  removes Hermes stages for approval vanish when the turn ends. The replay counts them.
- The review's chat and user are a synthetic owner ID; no request carries them.
- The live turn container has no network apart from Nocheh. This container has one,
  for the relay. The guard route refuses every other destination, and a review process
  looks up and connects to nothing but the broker address (checked with a connection
  log while building this tool).
- Runs follow each other within minutes, so Anthropic's prompt cache can carry a
  cached prefix from one Messages API run to the next. That changes cost, not output.

</how_it_works>

<operator_steps>

On the development machine that holds the live installation and its image. Placeholders:
`<checkout>` is the Nocheh checkout, `<ref>` the branch or commit holding this folder
(`main` once merged), `<state>` the installation's state folder (the one holding
`hermes/profiles`), `<db container>` the installation's `nocheh-db` container
(`docker ps --filter label=com.docker.compose.service=nocheh-db --format '{{.Names}}'`).

1. Check that the image holds the Hermes that `main` pins: the first value must equal
   `hermes.revision` in the second.

   ```sh
   docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' nocheh-hermes:local
   git -C <checkout> show main:deploy/upstreams.lock.json
   ```

2. Make a scratch folder outside the checkout and export the code. `work/export` takes
   the database reads, `work/in` the replay's inputs (mounted read-only), `work/out` its
   results (the only writable mount).

   ```sh
   umask 077
   REPLAY=$(mktemp -d)
   mkdir -p "$REPLAY/code" "$REPLAY/replay" "$REPLAY/work/export" "$REPLAY/work/in/template/memories" "$REPLAY/work/out"
   git -C <checkout> archive main | tar -x -C "$REPLAY/code"
   git -C <checkout> archive <ref> tools/development/review_replay | tar -x -C "$REPLAY/replay"
   ```

3. Check that the guard is on now, then read the finished guard-mode-`on` reviews and
   their stored inputs, read-only. A review's input is the derived artifact
   `native-review-input:<review id>`, whose content is
   `canonical({text, evidence, dependencies})`; `text` is what the review sent.

   ```sh
   psql_ro() { docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' <db container> psql -X -q -A -t -v ON_ERROR_STOP=1 -U nocheh "$@"; }
   [ "$(psql_ro -d nocheh_control -c 'SELECT mode FROM guard_state WHERE singleton')" = on ] || echo 'STOP: the guard is not on'
   psql_ro -d nocheh_control > "$REPLAY/work/export/jobs.jsonl" <<'SQL'
   SELECT json_build_object('key',id,'event_id',source_reference->>'id','input_id',input_reference->>'id',
     'input_hash',input_reference->>'input_hash')
   FROM native_review_jobs WHERE state='done' AND binding->>'mode'='on' ORDER BY created_at;
   SQL
   ids() { python3 -c 'import json,sys;print(",".join(json.loads(l)[sys.argv[2]] for l in open(sys.argv[1])))' "$REPLAY/work/export/jobs.jsonl" "$1"; }
   psql_ro -d nocheh_derived -v ids="$(ids input_id)" > "$REPLAY/work/export/inputs.jsonl" <<'SQL'
   SELECT json_build_object('input_id',id,'operation_id',operation_id,'content_hash',content_hash,
     'text',convert_from(content,'UTF8')::jsonb->>'text')
   FROM derived_artifacts WHERE id=ANY(string_to_array(:'ids',','));
   SQL
   psql_ro -d nocheh_archive -v ids="$(ids event_id)" > "$REPLAY/work/export/events.jsonl" <<'SQL'
   SELECT json_build_object('event_id',id,'origin',origin,'channel',channel,'kind',kind)
   FROM events WHERE id=ANY(string_to_array(:'ids',','));
   SQL
   ```

4. Classify and select about 60 sources, 20 of each kind. **The repository does not
   define kinds i, ii and iii: the operator must write the agreed definition into
   `kind()` below before running it.** It sees the job, the fragment text (whose first
   line names the source event, its conversation and the fragment number) and the
   source event's origin, channel and kind; it returns `'i'`, `'ii'`, `'iii'` or `None`
   to leave a job out. The step checks each input against its job and prints counts only.
   Then it notes the newest review for step 5 and deletes the database reads, so only
   the selected fragments stay on disk.

   ```sh
   python3 - "$REPLAY/work" <<'PY'
   import collections, json, random, sys
   work = sys.argv[1]
   read = lambda name: [json.loads(line) for line in open(f'{work}/export/{name}') if line.strip()]
   inputs = {row['input_id']: row for row in read('inputs.jsonl')}
   events = {row['event_id']: row for row in read('events.jsonl')}

   def kind(job, text, event):
       raise SystemExit('fill in kind(): the agreed definition of kinds i, ii and iii')

   found = collections.defaultdict(list)
   for job in read('jobs.jsonl'):
       row = inputs.get(job['input_id'])
       if not row or row['operation_id'] != 'native-review-input:' + job['key'] or row['content_hash'] != job['input_hash'] \
               or not row['text'] or len(row['text']) > 12000:
           continue
       label = kind(job, row['text'], events.get(job['event_id'], {}))
       if label in ('i', 'ii', 'iii'):
           found[label].append({'key': job['key'], 'event_id': job['event_id'], 'kind': label, 'text': row['text']})
   rng = random.Random(1)
   with open(f'{work}/in/sources.jsonl', 'w') as out:
       for label in ('i', 'ii', 'iii'):
           for row in rng.sample(found[label], min(20, len(found[label]))):
               out.write(json.dumps(row, ensure_ascii=False) + '\n')
   print({label: f'{min(20, len(rows))} of {len(rows)}' for label, rows in sorted(found.items())})
   PY
   NEWEST=$(tail -n 1 "$REPLAY/work/export/jobs.jsonl" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
   rm -r "$REPLAY/work/export"
   ```

5. Copy the settings of the owner's current assistant profile into the template: the
   profile whose `reviews/` holds the newest job's receipt (if none does, the owner's
   newest profile folder), and the global preferences beside the profiles. The notes
   start empty, as at the start of a guard epoch. A review loads neither the role
   (`SOUL.md`) nor skills.

   ```sh
   PROFILE=$(dirname "$(dirname "$(ls -d <state>/hermes/profiles/*/reviews/"$NEWEST")")")
   cp "$PROFILE/config.yaml" "$REPLAY/work/in/template/"
   : > "$REPLAY/work/in/template/memories/MEMORY.md"; : > "$REPLAY/work/in/template/memories/USER.md"
   [ -f <state>/hermes/nocheh-policy.yaml ] && cp <state>/hermes/nocheh-policy.yaml "$REPLAY/work/in/template/"
   ```

   Full-notes variant: copy the profile's current notes instead of emptying them, and
   print their sizes only. Hermes's limits are 2,200 characters for `MEMORY.md` and 1,375
   for `USER.md` unless `config.yaml` sets others.

   ```sh
   cp "$PROFILE/memories/MEMORY.md" "$PROFILE/memories/USER.md" "$REPLAY/work/in/template/memories/"
   wc -m "$REPLAY/work/in/template/memories/"*.md
   ```

6. Prompts: every run uses the defaults, `{}`, so no owner-written text leaves the
   machine without its secret check. The arms stay comparable, since all use the same
   texts. Count (never print) how many of the review's texts the owner replaced, so the
   report can say whether live reviews used other texts:

   ```sh
   echo '{}' > "$REPLAY/work/in/prompts.json"
   psql_ro -d nocheh_control -c "SELECT count(*) FROM owner_prompts, jsonb_object_keys(texts) AS key
     WHERE singleton AND key IN ('reply.common','reply.owner','memory.evidence','memory.notes_review')"
   ```

7. The reply model's context length. Hermes's own value, without network:

   ```sh
   CONTEXT_LENGTH=$(docker run --rm --network none nocheh-hermes:local python -c "from agent.model_metadata import get_model_context_length as g; print(g('claude-sonnet-5-5', base_url='https://api.anthropic.com/v1', api_key='', provider='openai'))")
   ```

   The launcher sends the value the Hermes service resolves for the reply route; use
   that if it is known to differ. A review stays far below either.

8. The provider key, typed, never echoed and not exported: `read -rs REPLAY_PROVIDER_KEY`.
   The `replay` function hands it to the driver on standard input (`printf` is a shell
   built-in, so the key is in no command line).

9. Smoke run: the first source once in each arm, each provider call printed.

    ```sh
    replay() {
      printf '%s\n' "$REPLAY_PROVIDER_KEY" | docker run -i --rm --read-only --tmpfs /tmp \
        --tmpfs "/profile:rw,nosuid,nodev,size=32m,uid=$(id -u),gid=$(id -g),mode=0700" \
        --cap-drop ALL --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
        --add-host nocheh-security:127.0.0.1 \
        -v "$REPLAY/code/services:/workspace/services:ro" -v "$REPLAY/code/tools:/workspace/tools:ro" \
        -v "$REPLAY/replay/tools/development/review_replay:/replay:ro" \
        -v "$REPLAY/work/in:/in:ro" -v "$REPLAY/work/out:/out" \
        nocheh-hermes:local python /replay/driver.py --sources /in/sources.jsonl --profile /in/template \
        --prompts /in/prompts.json --context-length "$CONTEXT_LENGTH" "$@"
    }
    replay --out /out/smoke --smoke --budget-dollars 2
    ```

    Expect four runs in state `done`, or `failed` with cause `pending_tool_result` when
    the review's input budget stopped it right after a tool call (live records that as
    `empty_answer`); arm A's calls on `chat`, B's, C's and D's on `messages`, all with status
    200, a call naming `memory` when the model asked to write a note, `GET .../models
    403` lines, no `/v1/guard 403` line, and `C thinking sent: between_tools`. Anything
    else is a reason to stop and look. Note the `spent:` line.

10. Full run, two repeats per source and arm by default. `--budget-dollars` applies to
    one `--out` folder, so give it what the smoke run left of the approved total: 15
    minus the smoke run's `spent:` figure.

    ```sh
    replay --out /out/full --seed 1 --budget-dollars <15 minus the smoke run's spend>
    ```

    It prints a line per run and the summary at the end. If it stops early (the budget,
    a run whose cost is not fully known, or a crash), check the spend on the provider's
    usage page, then go on in the same folder with the same arguments plus `--resume`:
    it skips the recorded runs and counts their cost toward the same cap. Never start
    over in a new folder with the full amount. To print the summary and statistics
    again, with the same bootstrap seed: `replay --analyze /out/full/results.jsonl --seed 1`.

    For full notes, one repeat of the old route, the live route and the wider budget:
    `replay --out /out/full-notes --arms A,B,D --repeats 1 --seed 2 --budget-dollars <cap>`.

11. Keep the printed summary, then delete everything: `rm -rf "$REPLAY"; unset REPLAY_PROVIDER_KEY`.

</operator_steps>

<tests>

Synthetic data only: a scripted provider in the test process, the real relay and the
real review subprocess. They need Python 3.14 with the pinned Hermes's dependencies.

```sh
HERMES_HOME=$(mktemp -d) PYTHONPATH=<hermes source>:<checkout> python -m unittest tools.development.review_replay.test_review_replay
```

</tests>
