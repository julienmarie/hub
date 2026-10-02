# Run lifecycle API validation

Owner: root. Date: 2026-10-02. Branch: `feat/public-run-lifecycle-api`.
Upstream Hub: `28f6c78833065fd282f9064f92a9aa61875dd359`.
Source Paseo: `433e67b18b7964a92d593bdc78c518143accfc8b` (the unchanged CI pin).

## Evidence

- Type checks (Node, Start, E2E), lint, formatter, schema drift check, and production build pass.
- Run lifecycle, agent sessions, and dispatch lifecycle: 25 tests pass. Memory and disk-backed
  embedded storage cover organization isolation, scoped observation, ETag, delivery-key lookup
  without redispatch, cancellation replay, late callback fencing, successor-step fencing,
  restart, and historical cleanup receipts without termination evidence.
- PostgreSQL migration and built-router integration: 28 tests pass. Real issued credentials
  exercise both new scopes through the built production router, tenant boundaries, cancellation,
  lookup, and replay. The additive migration updates the database scope constraint too.
- Full browser suite: 88 pass. After adding API-key permission controls, the authentication
  browser suite passes all 5 tests; it issues read/cancel credentials through the UI and verifies
  the authenticated production routes.
- Complete daemon regression suite: all 102 tests pass, including the activity-receipt idle
  deadline case. The separate dispatch lifecycle suite passes all 12 tests.
- Container build and Docker smoke check pass with the lifecycle migration.
- Source-daemon suites: 10 pass, 1 fails. The new real-daemon scenario observes and reconciles a
  run, cancels it, checks credential revocation and an archive acknowledgement, restarts Hub,
  then verifies durable read and same-command replay. No provider process quiescence is claimed.

## Qualification limitation

The existing test `validates and installs the exact authored bundle through the source-built CLI`
times out waiting for the source daemon provider snapshot to include every named bundle agent.
Configuration validation returns 422 during that wait. The same timeout reproduces on a fully
built, unchanged upstream Hub checkout at the same source Paseo pin. One earlier baseline run
returned transient authentication-unavailable instead. Provider credentials, models, and the
immutable CI pin were preserved; the failing test was not skipped or weakened.

The initial full unit/integration sweep reported 1367 passes and two failures: the expected
migration count and the activity-receipt idle-deadline regression. The migration expectation is
updated and all 24 migration tests pass; the activity-receipt regression passes independently.
The complete daemon regression rerun passes all 102 tests. The complete
unit sweep has not been repeated after those fixes; this is not an all-green CI claim.

This branch is a reviewable fork change, not a release or a production admission change.
Alma still owns artifact validation and milestone acceptance. Its general Hub routing remains
disabled until consumer integration, synthetic milestones, recovery qualification, and the
observation period are complete. An upstream submission also needs the companion public-docs
change required by MAINTAINERS.md.
