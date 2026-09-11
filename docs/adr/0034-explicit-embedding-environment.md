# ADR-0034: Explicit embedding provider, model and key

Accepted 2026-09-09; extends ADR-0033 without changing its privacy or spending limits.

The owner requested separate `.env` settings for the embedding provider, model and
OpenAI API key, and selected OpenAI only for now. Use
`NOCHEH_EMBEDDING_PROVIDER=openai`,
`NOCHEH_EMBEDDING_MODEL=text-embedding-3-small` and `OPENAI_API_KEY`.
Keep the key private, excluded from Git, redacted in owner settings, and mounted
only into the embeddings gateway. Reasoning continues through subscription routes.

The allowed models are `text-embedding-3-small` and `text-embedding-3-large`, both
requested at 1536 dimensions. Their reviewed prices are $0.02 and $0.13 per million
input tokens. Reserve $0.01 and $0.02 respectively before each request bounded to
131,072 input bytes/tokens. Preserve the $5 pilot and $5 monthly limits across
restarts and failures. Unknown providers/models fail before provider requests.
Sources: [small](https://developers.openai.com/api/docs/models/text-embedding-3-small),
[large](https://developers.openai.com/api/docs/models/text-embedding-3-large),
[dimensions](https://developers.openai.com/api/docs/guides/embeddings), checked today.

The first paid attempt binds the ledger to its embedding model. A later model
change is blocked to prevent mixing incompatible vectors; rebuilding existing
Honcho memory for another model is separate work. Spending history must never be
deleted to enable a model change. The legacy `NOCHEH_EMBEDDING_API_KEY` migrates
when the new key is absent. An explicitly empty new key revokes the saved key.

The configured default and dedicated key were saved locally. One synthetic
OpenAI request returned HTTP 429; $0.01 remains reserved. This is pending provider
acceptance, not proof of successful embeddings or a confirmed billed charge.
