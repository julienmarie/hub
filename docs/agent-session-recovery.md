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
