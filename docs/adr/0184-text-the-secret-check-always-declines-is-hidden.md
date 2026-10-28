# ADR-0184: Text the secret check always declines is hidden whole

<status>
Accepted on 2026-10-28 after the owner's development install reran its stuck
notes reviews: Anthropic's safety filter declined one short archived message
on every secret check, so every review that included it failed, and the
retries and halving behind it made about 287 declined checks in 20 minutes.
Extends the secret guard in
[ADR-0010](0010-multimodal-ingestion-model-roles-secret-guard.md).
</status>

<context>
Every text bound for a model first passes the secret check, which returns the
exact secret values to mask. Anthropic reports a check its safety filter
declines as `finish_reason: content_filter` with no content. Most declines are
random and pass when asked again, so a declined check is asked once more, and
a batch still declined is checked again in halves. A single text still
declined failed the whole check, and with it the turn, the preparation or the
notes review that needed it.

Some text is declined every time. Such a text can never pass the check, so
everything that includes it failed at every attempt, and each attempt repeated
the whole halving.
</context>

<decision>

- A single text that the secret check declines twice on its own is returned
  whole as a secret value. The guard masks it like any other secret, so it
  never reaches a model unchecked, and the rest of the batch is used as
  checked.
- Halving splits a batch at the separator its caller used: the prepared
  context fragment separator, or the field boundary of a guarded request.
- Hermes writes one log line with the hidden text's length, never its
  content; the declined calls stay counted as failed guard calls on the Usage
  page.

</decision>

<consequences>

- A text the provider always declines no longer blocks its turn, preparation
  or notes review; the model sees it as a masked secret instead.
- Once a hidden text's check result is stored, later preparations reuse it and
  do not ask the provider again.
- If a provider declined every check, every text would be hidden; the failed
  guard calls on the Usage page and the log lines show it.

</consequences>
