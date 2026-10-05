import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { createRunLifecycleOperations } from "./run-lifecycle.js";
import { createPublicOperations, internalDeliveryId } from "./index.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";
import { createPublicApi } from "../public-api/index.js";
import { ManualRunNotStartedSchema, RunSnapshotSchema } from "../public-api/run-contracts.js";
import type { ApiKeyScope } from "../auth/api-key-contract.js";

const access = {
  kind: "apiKey" as const,
  organizationId: "org",
  credentialId: "key",
  scopes: ["runs:read", "runs:cancel"] as const,
};
async function fixture(database: Database) {
  const project = await database.createProject({
    organizationId: "org",
    name: "Project",
    slug: "project",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "fixture",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  const receipt = await database.persistManualEvent({
    organizationId: "org",
    projectId: project.id,
    deliveryId: internalDeliveryId("org", project.id, "lost-ack"),
    source: "manual.run",
    payload: { publicDeliveryKey: "lost-ack" },
    receivedAt: new Date(),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("receipt missing");
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: "org",
    projectId: project.id,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "analyze",
    prompt: "Analyze",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(Date.now() + 60_000),
    stepIds: ["download", "analyze", "report"],
  });
  const executionInput = {
    organizationId: "org",
    projectId: project.id,
    configurationRevisionId: revision.id,
    machineId: null,
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(Date.now() + 60_000),
    idleDeadlineAt: new Date(Date.now() + 30_000),
    startedAt: new Date(),
  };
  const executionId = randomUUID();
  await database.createWorkflowStepExecution({
    triggerRunId: run.id,
    stepId: "download",
    ordinal: 0,
    executionId,
    execution: { ...executionInput, id: executionId },
  });
  const lifecycle = createRunLifecycleOperations(database, async () => {});
  const operations = createPublicOperations(createDatabasePublicOperationRepository(database), {
    runLifecycle: lifecycle,
    configurationForProject: () => {
      throw new Error("not used");
    },
    validateBundleForOrganization: async () => {
      throw new Error("not used");
    },
    dispatchManualEvent: async () => {
      throw new Error("lookup must never dispatch");
    },
  });
  const api = createPublicApi(
    {
      status: "enabled",
      authenticator: {
        authorize: async (incoming, requiredScope) => {
          if (incoming.headers.get("authorization") !== "Bearer fixture")
            return { status: "unauthorized" };
          if (incoming.headers.get("x-test-scope") !== requiredScope)
            return { status: "forbidden" };
          return { status: "authorized", access };
        },
      },
    },
    operations,
  );
  return { database, run, executionId, executionInput, lifecycle, api };
}
function request(path: string, scope: ApiKeyScope, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("authorization", "Bearer fixture");
  headers.set("x-test-scope", scope);
  headers.set("content-type", "application/json");
  return new Request(`http://hub.test${path}`, { ...options, headers });
}

describe("durable public run lifecycle", () => {
  it("reconciles a lost dispatch acknowledgement without dispatching and enforces scopes and conditional reads", async () => {
    const f = await fixture(createMemoryDatabase({ organizationIds: ["org", "other"] }));
    const path = `/api/v1/runs/${f.run.id}`;
    const first = await f.api.handle(request(path, "runs:read"));
    assert.equal(first.status, 200);
    const snapshot = RunSnapshotSchema.parse(await first.json());
    assert.equal(snapshot.status, "running");
    assert.deepEqual(
      snapshot.steps.map((s) => s.stepId),
      ["download", "analyze", "report"],
    );
    const lookup = await f.api.handle(
      request(
        "/api/v1/manual-runs?projectSlug=project&trigger=analyze&deliveryKey=lost-ack",
        "runs:read",
      ),
    );
    assert.deepEqual(await lookup.json(), snapshot);
    assert.equal(
      (
        await f.api.handle(
          request(path, "runs:cancel", {
            headers: { "if-none-match": first.headers.get("etag")! },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api.handle(
          request(path, "runs:read", { headers: { "if-none-match": first.headers.get("etag")! } }),
        )
      ).status,
      304,
    );
    assert.equal((await f.api.handle(request("/api/v1/runs/invalid", "runs:read"))).status, 400);
    assert.equal(
      (
        await f.api.handle(
          request(
            "/api/v1/manual-runs?projectSlug=project&trigger=analyze&deliveryKey=x&deliveryKey=y",
            "runs:read",
          ),
        )
      ).status,
      400,
    );
    assert.deepEqual(
      await f.lifecycle.readRun({ ...access, organizationId: "other" }, { runId: f.run.id }),
      { status: "run_not_found" },
    );
    assert.deepEqual(
      await f.lifecycle.cancelRun(
        { ...access, organizationId: "other" },
        { runId: f.run.id, commandId: randomUUID() },
      ),
      { status: "run_not_found" },
    );
    assert.deepEqual(
      await f.lifecycle.lookupManualRun(access, {
        projectSlug: "project",
        trigger: "analyze",
        deliveryKey: "missing",
      }),
      { status: "run_not_found" },
    );
  });

  it("exposes a durable negative receipt only after a dropped manual event is fenced, and replay cannot invoke its handler", async () => {
    const f = await fixture(createMemoryDatabase({ organizationIds: ["org"] }));
    const key = "fenced-before-start";
    const expectedVersionId = randomUUID();
    const input = {
      organizationId: "org",
      projectId: f.run.projectId,
      deliveryId: internalDeliveryId("org", f.run.projectId, key),
      source: "manual.run" as const,
      payload: {
        trigger: "analyze",
        actor: "alma",
        input: "bounded",
        publicDeliveryKey: key,
        expectedVersionId,
      },
      receivedAt: new Date(),
    };
    const pending = await f.database.persistManualEvent(input);
    assert.equal(pending.status, "accepted");
    if (pending.status !== "accepted") throw new Error("receipt missing");
    const query = { projectSlug: "project", trigger: "analyze", deliveryKey: key };
    assert.deepEqual(await f.lifecycle.lookupManualRun(access, query), { status: "run_not_found" });
    await f.database.markProviderEventDropped(
      pending.event.providerEventReceiptId,
      "configuration_unavailable",
    );
    const response = await f.api.handle(
      request(
        `/api/v1/manual-runs?projectSlug=project&trigger=analyze&deliveryKey=${key}`,
        "runs:read",
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(ManualRunNotStartedSchema.parse(await response.json()), {
      status: "not_started",
      providerEventReceiptId: pending.event.providerEventReceiptId,
      deliveryKey: key,
      trigger: "analyze",
      configurationRevisionId: expectedVersionId,
      reason: "configuration_unavailable",
    });
    const transientKey = "same-version-transient";
    const transient = await f.database.persistManualEvent({
      ...input,
      deliveryId: internalDeliveryId("org", f.run.projectId, transientKey),
      payload: {
        ...input.payload,
        publicDeliveryKey: transientKey,
        expectedVersionId: f.run.configurationRevisionId,
      },
    });
    if (transient.status !== "accepted") throw new Error("transient fixture missing");
    await f.database.markProviderEventDropped(
      transient.event.providerEventReceiptId,
      "configuration_unavailable",
    );
    assert.deepEqual(
      await f.lifecycle.lookupManualRun(access, { ...query, deliveryKey: transientKey }),
      { status: "run_not_found" },
    );
    const { createManualTriggerSource, dispatchManualTrigger } =
      await import("../triggers/manual/source.js");
    const source = createManualTriggerSource(f.database);
    let handled = 0;
    await source.start(async () => {
      handled += 1;
    });
    await dispatchManualTrigger(source, input);
    assert.equal(handled, 0);
    assert.equal(
      (
        await f.database.findTriggerRunsByProviderEventReceiptId(
          pending.event.providerEventReceiptId,
        )
      ).length,
      0,
    );
  });

  for (const driver of ["memory", "embedded"] as const) {
    it(`process exit receipts survive restart and reject foreign bindings on ${driver}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hub-process-proof-"));
      let bundle =
        driver === "embedded" ? await embeddedDatabaseRuntime(join(root, "database")) : undefined;
      if (bundle) {
        await bundle.runtime.migrate();
        await bundle.runtime.query(
          "insert into organization(id,name,slug) values('org','Org','org')",
        );
      }
      let db = bundle
        ? createDatabase(bundle.runtime, bundle.locks)
        : createMemoryDatabase({ organizationIds: ["org"] });
      try {
        const f = await fixture(db),
          daemonId = randomUUID(),
          sessionId = randomUUID(),
          token = randomUUID();
        await db.issueEnrollmentToken({
          id: randomUUID(),
          verifier: token,
          organizationId: "org",
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        });
        await db.enrollDaemon({
          daemonId,
          idempotencyKey: randomUUID(),
          tokenVerifier: token,
          serverId: "process-test",
          daemonPublicKey: "public-test",
          credentialVerifier: "credential-test",
          permissions: ["hub.execute"],
          now: new Date(),
        });
        await db.attachAgentToExecution(f.executionId, daemonId, "agent");
        await db.saveAgentSession({
          id: sessionId,
          organizationId: "org",
          projectId: f.run.projectId,
          continuationKey: null,
          daemonId,
          agentId: "agent",
          workspaceId: "workspace",
          compatibility: "test",
          creationOptions: {
            provider: "codex",
            cwd: "/tmp",
            env: {},
            toolPolicy: { preapproved: [] },
          },
          capabilityTokenHash: "test",
          tools: [],
        });
        await db.attachExecutionToSession(f.executionId, sessionId);
        const proof = {
          kind: "provider_group" as const,
          requestId: randomUUID(),
          agentId: "agent",
          workspaceId: "workspace",
          provider: "codex" as const,
          pid: 321,
          processGroupId: 321,
          observedAt: new Date().toISOString(),
          exitCode: null,
          signal: "SIGTERM",
          executionId: f.executionId,
          daemonId,
          sessionId,
        };
        assert.equal(await db.recordAgentExecutionProcessExit("org", f.executionId, proof), false);
        await db.failWorkflowRun(f.run.id, "timed_out", "whole_run_timeout");
        await db.transitionAgentExecution(f.executionId, "failed", { hubAction: "archive" });
        for (const wrong of [
          { ...proof, workspaceId: "foreign" },
          { ...proof, agentId: "foreign" },
          { ...proof, daemonId: randomUUID() },
          { ...proof, processGroupId: 999 },
        ])
          assert.equal(
            await db.recordAgentExecutionProcessExit("org", f.executionId, wrong),
            false,
          );
        assert.equal(
          await db.recordAgentExecutionProcessExit("foreign", f.executionId, proof),
          false,
        );
        assert.equal(await db.recordAgentExecutionProcessExit("org", f.executionId, proof), true);
        assert.equal(await db.recordAgentExecutionProcessExit("org", f.executionId, proof), true);
        if (bundle) {
          await bundle.runtime.close();
          bundle = await embeddedDatabaseRuntime(join(root, "database"));
          db = createDatabase(bundle.runtime, bundle.locks);
        }
        const stored = await db.findAgentExecutionById(f.executionId);
        assert.deepEqual(stored?.hubActionAcknowledgements.processExit, proof);
        const snapshot = await createRunLifecycleOperations(db, async () => {}).readRun(access, {
          runId: f.run.id,
        });
        assert.equal(snapshot.status, "found");
        if (snapshot.status !== "found") throw new Error("missing run");
        assert.equal(snapshot.snapshot.steps[0]?.execution?.cleanup.stopStatus, "process_exited");
      } finally {
        await bundle?.runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    it(`terminal cleanup preserves outcome and exact cancellation identity on ${driver}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hub-terminal-cleanup-"));
      const bundle =
        driver === "embedded" ? await embeddedDatabaseRuntime(join(root, "database")) : undefined;
      if (bundle) {
        await bundle.runtime.migrate();
        await bundle.runtime.query(
          "insert into organization(id,name,slug) values('org','Org','org')",
        );
      }
      const database = bundle
        ? createDatabase(bundle.runtime, bundle.locks)
        : createMemoryDatabase({ organizationIds: ["org"] });
      try {
        const f = await fixture(database);
        await database.failWorkflowRun(f.run.id, "timed_out", "whole_run_timeout");
        const id = randomUUID();
        assert.equal(
          (await database.cancelWorkflowRun("org", f.run.id, id, new Date())).status,
          "run_terminal",
        );
        assert.equal(
          (await database.cancelWorkflowRun("foreign", f.run.id, id, new Date(), true)).status,
          "run_not_found",
        );
        assert.equal(
          (await database.cancelWorkflowRun("org", f.run.id, id, new Date(), true)).status,
          "accepted",
        );
        assert.equal(
          (await database.cancelWorkflowRun("org", f.run.id, id, new Date(), true)).status,
          "accepted",
        );
        assert.equal(
          (await database.cancelWorkflowRun("org", f.run.id, randomUUID(), new Date(), true))
            .status,
          "command_conflict",
        );
        const snapshot = await database.readWorkflowRun("org", f.run.id);
        assert.equal(snapshot?.run.status, "timed_out");
        assert.equal(snapshot?.run.failureReason, "whole_run_timeout");
        assert.equal(snapshot?.cancellation?.commandId, id);
        assert.equal(snapshot?.executions[0]?.hubAction, "archive");
      } finally {
        await bundle?.runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    it(`fences callbacks and future steps, replays cancellation and persists cleanup receipts on ${driver}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hub-run-lifecycle-"));
      let bundle =
        driver === "embedded" ? await embeddedDatabaseRuntime(join(root, "database")) : undefined;
      if (bundle) {
        await bundle.runtime.migrate();
        await bundle.runtime.query(
          "insert into organization (id, name, slug) values ('org', 'Org', 'org')",
        );
      }
      let database = bundle
        ? createDatabase(bundle.runtime, bundle.locks)
        : createMemoryDatabase({ organizationIds: ["org"] });
      try {
        const f = await fixture(database);
        const negativeKey = "negative-restart";
        const expectedNegativeVersion = randomUUID();
        const negativeInput = {
          organizationId: "org",
          projectId: f.run.projectId,
          deliveryId: internalDeliveryId("org", f.run.projectId, negativeKey),
          source: "manual.run" as const,
          payload: {
            trigger: "analyze",
            actor: "alma",
            input: "bounded",
            expectedVersionId: expectedNegativeVersion,
            publicDeliveryKey: negativeKey,
          },
          receivedAt: new Date(),
        };
        const negative = await database.persistManualEvent(negativeInput);
        if (negative.status !== "accepted") throw new Error("negative fixture missing");
        await database.markProviderEventDropped(
          negative.event.providerEventReceiptId,
          "configuration_unavailable",
        );
        const commandId = randomUUID();
        const cancelPath = `/api/v1/runs/${f.run.id}/cancel`;
        const cancelled = await f.api.handle(
          request(cancelPath, "runs:cancel", {
            method: "POST",
            body: JSON.stringify({ commandId }),
          }),
        );
        assert.equal(cancelled.status, 202);
        const snapshot = RunSnapshotSchema.parse(await cancelled.json());
        assert.equal(snapshot.terminal, true);
        assert.equal(snapshot.failureReason, "operator_cancelled");
        assert.equal(snapshot.steps[0]?.execution?.cleanup.stopStatus, "unconfirmed");
        assert.equal(snapshot.steps.filter((s) => s.status === "failed").length, 3);
        assert.equal(
          (
            await database.completeWorkflowAgentExecution({
              executionId: f.executionId,
              executionStatus: "succeeded",
              stepStatus: "succeeded",
              stepOutput: { late: true },
            })
          ).transitioned,
          false,
        );
        const secondId = randomUUID();
        const blocked = await database.createWorkflowStepExecution({
          triggerRunId: f.run.id,
          stepId: "analyze",
          ordinal: 1,
          executionId: secondId,
          execution: { ...f.executionInput, id: secondId },
        });
        assert.equal(blocked.created, false);
        assert.equal(await database.findAgentExecutionById(secondId), undefined);
        assert.equal(await database.claimWorkflowWakeup(new Date(), 30_000), undefined);
        if (bundle) {
          await bundle.runtime.close();
          bundle = await embeddedDatabaseRuntime(join(root, "database"));
          database = createDatabase(bundle.runtime, bundle.locks);
        }
        const lifecycle = createRunLifecycleOperations(database, async () => {});
        assert.equal(
          (
            await lifecycle.lookupManualRun(access, {
              projectSlug: "project",
              trigger: "analyze",
              deliveryKey: negativeKey,
            })
          ).status,
          "not_started",
        );
        assert.equal((await database.persistManualEvent(negativeInput)).status, "duplicate");
        assert.equal(
          (
            await database.findTriggerRunsByProviderEventReceiptId(
              negative.event.providerEventReceiptId,
            )
          ).length,
          0,
        );
        const replay = await lifecycle.cancelRun(access, { runId: f.run.id, commandId });
        assert.equal(replay.status, "accepted");
        if (replay.status === "accepted")
          assert.deepEqual(replay.snapshot.cancellation, snapshot.cancellation);
        assert.deepEqual(
          await lifecycle.cancelRun(access, { runId: f.run.id, commandId: randomUUID() }),
          { status: "command_conflict" },
        );
        // A legacy timestamp without a disposition cannot be used as stop confirmation.
        await database.completeHubAction(f.executionId, "archive");
        const legacy = await lifecycle.readRun(access, { runId: f.run.id });
        assert.equal(legacy.status, "found");
        if (legacy.status === "found")
          assert.equal(legacy.snapshot.steps[0]?.execution?.cleanup.stopStatus, "unconfirmed");
      } finally {
        await bundle?.runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  }

  it("reports completed output and rejects cancellation after successful workflow completion", async () => {
    const f = await fixture(createMemoryDatabase({ organizationIds: ["org"] }));
    await f.database.completeWorkflowAgentExecution({
      executionId: f.executionId,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      stepOutput: { report: "artifact://report" },
      hubAction: "archive",
    });
    await f.database.completeHubAction(f.executionId, "archive", "applied");
    await f.database.succeedTriggerRun(f.run.id);
    const result = await f.lifecycle.readRun(access, { runId: f.run.id });
    assert.equal(result.status, "found");
    if (result.status === "found") {
      assert.deepEqual(result.snapshot.steps[0]?.output, { report: "artifact://report" });
      assert.equal(result.snapshot.steps[0]?.execution?.cleanup.stopStatus, "archive_acknowledged");
    }
    assert.deepEqual(
      await f.lifecycle.cancelRun(access, { runId: f.run.id, commandId: randomUUID() }),
      { status: "run_terminal" },
    );
  });
});
