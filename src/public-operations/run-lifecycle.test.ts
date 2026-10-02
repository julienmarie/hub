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
import { RunSnapshotSchema } from "../public-api/run-contracts.js";
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

  for (const driver of ["memory", "embedded"] as const) {
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
