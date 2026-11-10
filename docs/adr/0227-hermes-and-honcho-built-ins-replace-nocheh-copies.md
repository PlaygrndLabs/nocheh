# ADR-0227: Hermes and Honcho built-ins replace Nocheh's own copies

<status>
Accepted on 2026-11-10, after the November 9 upgrade to Hermes 0.23.0 and
Honcho 3.6.0 (owner: "want to update hermes + honcho and other packages, for
services check the change log to understand what is new and can use it and what
is changed and need code update in our side"). The owner chose Honcho's exact
message citations and a larger memory question: "I like this one, dont apply
limit use memory fully and use all features.", and said "yes" to a second change
with the Hermes instruction refresh, exact memory sources, the bigger question
limit and the Persian voice fix. Amends how
[ADR-0128](0128-learning-results-keep-valid-items.md) reads a saved learning
result (bare, fenced or wrapped JSON) and replaces the cut-off reading of
[ADR-0140](0140-truncated-learning-results-keep-whole-items.md); both keep their
item rules. Extends the role and skills of
[ADR-0151](0151-chat-role-and-skills-in-hermes-profiles.md) and
[ADR-0196](0196-projects-have-their-own-role-and-skills.md). Honcho peer cards
and dreams stay off ([ADR-0225](0225-member-safety-rules.md)).
</status>

<context>
- Hermes reuses a continuing session's stored system prompt so the provider's
  prompt cache stays warm. Nocheh kept its own per-session marker
  (`native-state/persona-prompt.json`) and, on each turn whose role revision
  differed, cleared that session's stored prompt and tool list. Hermes 0.23 has
  its own refresh: `SessionDB.request_prompt_refresh()` records an epoch in the
  profile's `state.db`, a session whose stored prompt predates it rebuilds once
  on its next turn, keeping its history and tool list, and compaction carries the
  epoch to the child session.
- Honcho 3.5 and later records the messages each explicit conclusion cites
  (`conclusion_source_messages`). Nocheh's provenance reader knew only each
  conclusion's whole derivation batch (`internal_metadata.message_ids`), so every
  chain was labeled `ancestry_is_not_an_exact_citation` and never exact.
- The pinned Honcho rejected a reasoning query over 10,000 characters, so Nocheh
  trimmed the learning query to that. Honcho now takes
  `DIALECTIC_MAX_QUERY_LENGTH` up to 200,000 characters and keeps each reasoning
  round and summary within an input token budget. Nocheh's guard refuses any model
  request over 512 KiB.
- Honcho's peer chat takes a `response_format` JSON schema, checks the model's
  answer against it and repairs it, retrying when it cannot. Nocheh recovered
  fenced, sentence-wrapped and cut-off JSON itself.
- The meter sent archive preparation requests ASCII-escaped, which makes Persian
  text about three times larger than the request the guard measured.
</context>

<decision>

Prompt refresh:

- Writing a profile's role and skills (`persona._install`, from an owner save
  into a chat's own profile or a turn's materialize, under the profile's
  `.persona.lock`) asks Hermes to refresh the whole profile once the files are in
  place. It asks only when the profile already has a session database and never
  creates one, so the default's, a project's and source folders are skipped.
  Materialize writes only when the effective role or skills changed, so each
  change rebuilds a continuing session once; default and project saves reach a
  turn profile through its next materialize.
- The marker, `refresh_prompt` and its per-turn call are removed. Hermes keeps a
  session's tool list across the rebuild; a turn's tools come from the fixed
  allowlist, not from the role.

Exact citations:

- The provenance reader takes each conclusion's cited messages from
  `conclusion_source_messages`, matched on tenant and conclusion, joined to
  messages by public ID, in citation order. A conclusion with no citations falls
  back to its derivation batch.
- Each conclusion node carries `exact_citations`: true when it brought the
  messages it cites, false when it fell back to a batch, null when it brought
  none, such as a derived conclusion with only parents. A chain is exact only when
  at least one node is true and none is false, and
  `ancestry_is_not_an_exact_citation` is added only when a node is false. The
  Node reader recomputes this from the nodes and refuses a node without the field.
- Cited messages come first and win the 256-message cap over batch messages.
  Workspace scoping, deleted ancestors and the other limitations are as before.
- Recall's answer source stays `exact_citations: false`: a reasoning answer does
  not say which of the conclusions it read it relied on.

Question size:

- Setup writes `DIALECTIC_MAX_QUERY_LENGTH=200000`, Honcho's maximum, and
  `DIALECTIC_MAX_INPUT_TOKENS` and `SUMMARY_MAX_INPUT_TOKENS` of 61,440. At 8
  bytes a token they fill 480 KiB, leaving 32 KiB of the guard's 512 KiB for
  the tool and answer schemas Honcho adds outside its budget and the request's
  JSON. English, Persian and Russian measure about 5 to 6.7 bytes a token.
- The learning query gets about half that input budget, counted at 3 bytes a
  token: 92,160 UTF-8 bytes, within 200,000 characters. The rest is left for
  what Honcho gathers. Learning queries measure about 2.4 to 6.4 bytes a token,
  so an id-heavy query can take about 61% of the tokens. The trimming ladder
  shortens a query only past that size, and a test keeps the TypeScript and
  setup numbers equal.
- The meter sends archive preparation requests as plain UTF-8.

Strict JSON for learning:

- Learning sends `response_format` with the learning result's schema. Item
  fields stay optional, allowed values are only described, and `evidence_ids`
  comes last in each item of the schema and of the prompt, which also asks the
  model to write it last. Nocheh still drops one invalid item on its own, and an
  item Honcho's repair kept after a cut has no evidence when the model wrote
  `evidence_ids` last. The top level requires `interpretations`.
- Every dialectic level uses `STRUCTURED_OUTPUT_MODE=json_object`, which puts the
  schema in the prompt instead of sending a non-strict `json_schema` beside the
  round's tools, which an OpenAI-compatible endpoint can refuse.
- The saved result is parsed as one strict JSON object. Nocheh's fence, sentence
  and cut-off recovery is removed. An unusable result is still
  `invalid_interpretation_result` and closes the job. Honcho's nulls mean absent
  fields, also in organization creates and assignments; a null creates or
  assignments list is empty.

</decision>

<consequences>
- A role or skill change reaches continuing sessions without Nocheh tracking
  each one. If the refresh request fails after a turn profile's files are
  written, the turn fails and its derived `SOUL.md` is removed, so the next turn
  installs the role again and asks again. A failed save of the owner's own
  files reports the error to the owner and is not undone. Hermes'
  rebuild does not fire `on_session_start`; Nocheh registers no such hook.
- Memory evidence can show the exact messages a memory came from. Conclusions
  from before Honcho 3.5, and ones whose model left out citations, still show
  their batch and are marked inexact. Honcho does not backfill citations;
  rebuilding Honcho memory gives existing conclusions theirs.
- `/nocheh/provenance` and `/v1/memory/provenance` carry `exact_citations` on
  each conclusion, and the top-level value is a real boolean.
- Learning can ask about far more evidence at once. Indic scripts (Hindi about
  10, Bengali and Tamil about 9 bytes a token) and text with long runs of spaces
  can still pass 512 KiB at a full input budget, and the guard refuses that
  request. Lowering the budget to cover them would cost every language context.
- An answer that still fails the schema after Honcho's retries comes back as
  Honcho's 422, which Nocheh treats as a retryable `honcho_upstream_rejected`.
  Saved learning results that were fenced, wrapped or cut off fail the strict
  parse.
- The dialectic output limit is 2,500 tokens, so a long learning answer can
  still be cut off; Honcho's repair keeps its leading items.
</consequences>
