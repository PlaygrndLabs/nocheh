# ADR-0246: The secret check on Anthropic defaults to Haiku 5.5

<status>
Accepted on 2026-11-13 on the owner's request to pick a Haiku model for the
secret check and make it the default. Refines
[ADR-0141](0141-per-part-model-providers.md): a part that names no model
used the main model; on Anthropic, the secret check now uses its own default.
</status>

<context>
- The secret check finds passwords, keys and tokens before any other model
  sees a text. Every message, file reading, transcript and memory request goes
  through it, so it is Nocheh's most frequent model call, and a small, fast
  model is enough for it.
- Its model followed the main model unless the owner chose another. A new
  installation's main model is `claude-sonnet-5-5`.
- On October 17, through a custom gateway, `claude-haiku-5-5` failed 15 of 70
  synthetic checks because it answered in prose instead of JSON. Since then the
  check asks for a strict JSON schema, but only on Anthropic's own API
  (`api.anthropic.com`), which holds the model to it. Other providers get the
  prompt's contract alone.
- On November 13, the production call path on Anthropic's API compared
  `claude-haiku-5-5` with `claude-sonnet-5` on 29 synthetic cases, five rounds
  each: secrets in English and Persian (also in Persian digits), API and cloud
  keys, a connection string, a sign-in code, recovery codes, a bearer header,
  JSON, a private key, fragments, long texts and an instruction to return
  nothing, plus near-misses such as a commit hash, a public ID and a mention of
  a password without its value. Both passed 145 of 145 with no missed secret,
  no extra value and no refusal. Haiku answered faster (median 1.2 s against
  1.56 s, p90 1.91 s against 2.18 s) at about a twentieth of the cost.
- The owner's installation has run the secret check on `claude-haiku-5-5`
  since November 8: 1,885 checks by November 13, none refused and no text
  hidden. Its 26 failures, all on November 8, were dropped connections, which
  connection reuse has fixed; none failed after that.
</context>

<decision>
- A part can have a default model per provider (`PART_DEFAULTS` in
  `tools/operations/provider/routes.py`). The secret check's is
  `claude-haiku-5-5` on the Anthropic provider.
- A part's model is the one the owner chose, else its default on the part's
  provider, else the main model. On any other provider an empty secret check
  model still follows the main model.
- Settings › Models names the default as the empty choice of the secret
  check's model, "Default (claude-haiku-5-5)", while the check's provider is
  Anthropic, and "Same as main (…)" otherwise.
</decision>

<alternatives>
- Writing `claude-haiku-5-5` into a new installation's `.env` would keep the
  check on that model after the owner adds OpenAI or a gateway with other
  model names, and every check would fail there with nothing in Settings
  saying why. It would also send Haiku through gateways without the strict
  schema that keeps its answers readable.
- Setting it as the empty default for every provider has the same problems.
- Changing `DEFAULTS` would leave every existing installation waiting for
  Apply once, because settings at their default are left out of the applied
  revision.
</alternatives>

<consequences>
- An installation on Anthropic whose secret check model is empty moves to
  `claude-haiku-5-5` the next time its services start. That changes the
  detector version, so guarded copies are made again, as for any detector
  change ([ADR-0141](0141-per-part-model-providers.md)). An installation with
  a chosen model keeps it.
- A gateway that serves Claude models keeps the main model for the secret
  check unless the owner picks another one.
- Check: [routes](../../services/hermes/test_provider_routes.py).
</consequences>
