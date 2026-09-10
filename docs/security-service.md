# Security service

The versioned `nocheh.security` service brokers isolated assistant requests.
Its policy library also runs inside the trusted archive executor, using the same
database and precedence. Thus an unavailable optional UI or broker does not remove
effect authorization. An isolated model has no direct provider fallback.
See [phase status](security-service-plan.md) before enabling the candidate.

From the repository root:

```sh
python3 -m scripts.security show
python3 -m scripts.security plugin
python3 -m scripts.security preview ACTION_ID --policy /absolute/path/policy.json
python3 -m scripts.security apply /absolute/path/policy.json --expected-revision 1
python3 -m scripts.security effects --effect ACTION_ID
```

The policy document is strict and versioned. Global rules omit selectors; scope,
profile, job and exact fingerprint selectors combine. All matching denies win,
then a valid bounded grant, then an explicit ask, then defaults. Example:

```json
{"version":1,"rules":[{"id":"pause-project-shell","kind":"shell","outcome":"deny","profile":"project"}]}
```

Supported configurable boundaries: controlled shell/browser/MCP operations,
explicit Telegram action requests, and isolated model/archive/memory reads.
Native memory writes stay inside the writable profile data directories; no
setting claims to intercept arbitrary filesystem writes. Guard on/off and sharing
policy remain separate mandatory controls. Existing selected-group conversation
and approved scheduled delivery keep their existing delivery policy.

Use the exact fingerprint returned by Activity or a policy preview to grant a
repeated operation. The owner explicitly chooses both limits; no hidden grants:

```sh
python3 -m scripts.security grant ACTION_ID --fingerprint FINGERPRINT --uses 100 --minutes 10080
python3 -m scripts.security revoke PERMISSION_ID
```

Grants bind exact arguments, scope and profile. A scheduled operation also binds
its job. Limits are 1–1000 uses and 1–43200 minutes (30 days). Changed arguments,
expiry or revocation need new authority. Ordinary authorized recall, drafting,
model calls and native memory work never request permission. This version does
not grant arbitrary shell commands or arbitrary URL/parameter combinations.

Owner policy edits use a required expected revision. Preview is read-only and
does not consume grants. Group members and model processes cannot edit policies,
grant permissions or read owner effect logs. Runtime policy applies at the next
authorization; an action already sent cannot be undone.

Effect records contain IDs, scope/profile, source reference, rule, origin, policy
revision and permission ID. They omit prompts, URLs, credentials and result text.
Inspect originals/results through the linked action and existing archive UI.
`allowed` means permission, `claimed` means an executor reservation, `started`
means a trusted executor/provider request attempt began, and `completed` means a
result was observed. Missing results are `ambiguous`; the executor never repeats
the effect automatically. Telegram recovery reads the runtime's durable receipt
using the existing idempotent action ID. A completed HTTP response is not a claim
that the model's answer was correct. Successful routine activity creates no alerts.

Owner API routes are `/v1/security/plugin`, `/policy`, `/preview` and `/effects`
(each prefixed by `/v1/security`). They are available through the owner archive
API and the service itself; scoped turn credentials cannot access them.

The trusted launcher is part of the host's security boundary: it owns Docker
authority. Agent containers do not. It pins the installed image ID at startup,
disables external DNS, mounts only native data plus read-only configuration, and
discards the turn filesystem on exit. Replacing it requires a trusted compatible
implementation; arbitrary plugin installation does not confer privileges.
