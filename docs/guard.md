# Optional outgoing guard

Set `NOCHEH_GUARD_MODE=off`, `on` or `auto` in the ignored
`.env`, then run `./scripts/nocheh up`. The default is `auto`.
`NOCHEH_GUARD_TRUSTED_ENDPOINTS` accepts a JSON array of exact URL prefixes;
defaults trust only the official ChatGPT subscription Codex endpoint.

The Python boundary inspects each serialized SDK attempt. The TypeScript guard
receives all textual fields together, including instructions, history, retrieved
memory, tool results and tool definitions. GPT returns literal candidates; local
code validates them and masks their exact occurrences. Casing, Unicode, line
endings and whitespace outside spans are preserved. Generated guarded views never
overwrite original archive records. The database cache key includes input,
destination, trust/mode policy, detector model/version and masking policy version.

Required guarding rejects detector outages, invalid candidates, quota failures,
oversized inputs, opaque media/server references and unsupported transports before
the protected request is sent. `off` and trusted `auto` routes do not depend on
guard availability. Authentication and Telegram Bot API transport are distinct
from inference. The trusted detector and subscription transcription may receive
originals. See [ADR-0020](adr/0020-mandatory-outgoing-request-guard.md).

Run behavior acceptance with `./scripts/nocheh test`. To repeat the synthetic
live detector and native chat checks with subscription authentication:

```sh
# Set NOCHEH_GUARD_MODE=on in .env first.
./scripts/nocheh up
docker compose exec -T hermes python -m integrations.hermes.verify_guard
# Restore your desired NOCHEH_GUARD_MODE in .env.
./scripts/nocheh up
```

The last command applies your restored `.env` setting. The live report is
`data/local/reports/guard-compatibility.json`. Only synthetic fixtures, pass/fail
results and content-free counters are recorded. Three fixtures are a small
detection-quality sample, not a guarantee of complete secret detection.
`/internal/status` exposes authenticated content-free failure codes and counters.

Enforcement tests exercise real SDK retries, route changes, redirects, synchronous
and asynchronous requests, and assert zero physical protected requests on guard
failure. Unicode span tests cover exact preservation separately from detection.
Unsupported non-HTTPX transports and opaque contexts fail closed. Arbitrary code
execution/network tools must remain disabled in scoped assistant profiles.
