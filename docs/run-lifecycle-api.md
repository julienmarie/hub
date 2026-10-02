# Observe, reconcile, and cancel runs

This fork adds durable run lifecycle operations under `/api/v1`. All operations use the
existing organization bearer credential. Grant `runs:read` for observation and `runs:cancel`
for cancellation; `runs:dispatch` alone grants neither. Update existing keys explicitly.

| Request                                                         | Purpose                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/runs/{runId}`                                      | Read the canonical workflow, frozen configuration revision, ordered steps, structured outputs, and execution/daemon/machine/agent bindings. |
| `GET /api/v1/manual-runs?projectSlug=…&trigger=…&deliveryKey=…` | Look up an existing manual dispatch after losing its acknowledgement.                                                                       |
| `POST /api/v1/runs/{runId}/cancel`                              | Persist a cancellation fence and request agent cleanup.                                                                                     |

Run reads return `200` and an `ETag`. Repeat an authorized GET with `If-None-Match` to
receive `304` when the snapshot is unchanged. Reads do not dispatch, reset deadlines, or
advance a workflow. Lookup continues to work for archived projects and disabled triggers.
A lookup returning `404` is **not** permission to redispatch: an original request might still
be in flight. Keep the original delivery key and reconcile before deciding to retry.

Cancellation accepts exactly `{"commandId":"<UUID>"}`. Persist the UUID before making the
request and reuse it after a timeout. The `202` follows an atomic transaction that records
the command, makes the workflow terminal with `failureReason: "operator_cancelled"`,
marks pending/running steps failed, terminalizes live executions, and queues archive actions.
Execution tools reject terminal executions, and the normal workflow engine cannot create
successor executions. A late spawn acknowledgement can still arrive; its prompt is fenced
and its cleanup is reconciled. Same-command replays retain the original request timestamp;
a different cancellation command returns `409`. A workflow already terminal before the
first cancellation also returns `409`, preserving its original outcome.

Logical cancellation and physical cleanup are separate. Inspect each execution's `cleanup`:

- `unconfirmed`: cleanup is pending, unavailable, or a historical receipt lacks evidence.
- `archive_acknowledged`: the daemon acknowledged the archive action for this execution's session.
- `shared_session_released`: newer live work owns the shared session; Hub did not archive it.
- `not_started`: no session, agent binding, or persisted launch intent existed.

An archive acknowledgement records the daemon control response. It is not a guarantee that
all provider processes have exited or that every external side effect has been reversed.
A terminal workflow does not imply physical termination. Offline daemons and lost control
acknowledgements remain unconfirmed until durable recovery receives a response. Startup and
reconnect recovery retry queued cleanup without dispatching another workflow.

The response's `steps[].output` is the accepted structured worker output for that workflow
step. Consumers still own artifact validation and milestone review; successful execution is
not consumer acceptance. Additional worker substeps can be reported through the consumer's
own authenticated progress channel (Alma uses `work.progress`) without turning them into new
Hub executions or granting organization keys to workers.

The generated OpenAPI at `/api/openapi.json` documents request fields, parameters,
scopes, responses, and the executable snapshot schema. No private Paseo APIs or protocol
extensions are required. The migration adds cancellation records and explicit cleanup
dispositions; legacy timestamps are intentionally not promoted to stop evidence.
