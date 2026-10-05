# Failed agent creation recovery

Terminal Hub execution cleanup reads Paseo's durable creation receipt using the
session's original idempotency key. It uses `creation.subscribe.request` with
`subscribe: false`, so inspection cannot retry agent creation.

A failed agent stage with `outcomeUnknown: false` and no registered agent can
settle cleanup as `not_started`. Hub checks the receipt kind and exact key, the
session's daemon, and the absence of active session executions under the existing
session lock. It rechecks the receipt within that lock before recording the
existing cleanup action's acknowledgement.

Missing receipts, pending creation, partial resources, unknown outcomes, prompt
failures and changed identities remain uncertain. The daemon connection must
support the receipt lookup. Recovery preserves the failed workflow and never
resubmits its launch or grants more authority. Started agents continue through
the ordinary interrupt/archive path; archive acknowledgement does not claim
physical process termination.

Paseo 0.10.2 supplies this receipt through its existing creation service. The
focused contract fixture also verifies the installed native creation engine and
Hub's pinned protocol accept the same read request after a service restart.

## Manual admission before an agent exists

A launch carrying expectedVersionId resolves its explicit project. A same-named
organization trigger cannot substitute its runtime project. Older accepted
receipts retain their original route on replay; a revision mismatch is checked
before parsing daemon settings and is durably dropped without creating a run.
Dropped manual deliveries are fenced against future replay in both database
drivers.

GET /api/v1/manual-runs can return a ManualRunNotStarted receipt when exactly one
scoped delivery exists, its pinned revision differs from its sole immutable route,
its configuration_unavailable drop is persisted, and it has no workflow runs.
The receipt binds the delivery key, trigger, requested configuration revision and
provider event identity. A transient error, same-version drop, missing delivery,
multiple candidate identities or existing run cannot establish this proof.
Lookup remains read-only. Consumers must validate the original frozen identity
before releasing an uncertain assignment; this is not an agent stop receipt.
