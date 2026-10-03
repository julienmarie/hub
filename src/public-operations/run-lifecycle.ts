import { createHash } from "node:crypto";
import type { AgentExecutionRecord, Database, WorkflowRunSnapshot } from "../db/types.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { reportFailure } from "../failures/index.js";
import { internalDeliveryId } from "./index.js";
import type { PublicOperations, RunLifecycleResult } from "./types.js";
import type { PublicRunSnapshot } from "../public-api/run-contracts.js";

export function createRunLifecycleOperations(
  database: Database,
  recover: (executionIds: readonly string[]) => Promise<void>,
  now = () => new Date(),
): Pick<PublicOperations, "readRun" | "lookupManualRun" | "cancelRun"> {
  async function guarded(
    operation: () => Promise<RunLifecycleResult>,
  ): Promise<RunLifecycleResult> {
    try {
      return await operation();
    } catch (error) {
      if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
      throw error;
    }
  }
  async function projectSnapshot(snapshot: WorkflowRunSnapshot): Promise<PublicRunSnapshot> {
    const workspaces = new Map<string, string>();
    await Promise.all(
      snapshot.executions.map(async (execution) => {
        if (!execution.agentSessionId) return;
        const session = await database.findAgentSession(execution.agentSessionId);
        if (
          session?.organizationId === snapshot.run.organizationId &&
          session.projectId === snapshot.run.projectId &&
          session.agentId === execution.daemonAgentId &&
          session.daemonId === execution.daemonId &&
          session.workspaceId
        )
          workspaces.set(session.id, session.workspaceId);
      }),
    );
    return publicSnapshot(snapshot, workspaces);
  }
  async function read(organizationId: string, runId: string): Promise<RunLifecycleResult> {
    const snapshot = await database.readWorkflowRun(organizationId, runId);
    return snapshot
      ? { status: "found", snapshot: await projectSnapshot(snapshot) }
      : { status: "run_not_found" };
  }
  return {
    readRun: (authorization, { runId }) => guarded(() => read(authorization.organizationId, runId)),
    lookupManualRun: (authorization, input) =>
      guarded(async () => {
        // Read-only reconciliation also works after a project is archived or a trigger disabled.
        const organizationId = authorization.organizationId;
        const trigger = (await database.listOrganizationTriggers(organizationId)).find(
          (t) => t.name === input.trigger,
        );
        const project = await database.findProjectBySlugForOrganization(
          organizationId,
          input.projectSlug,
        );
        const projectId = trigger?.runtimeProjectId ?? project?.id;
        if (!projectId) return { status: "run_not_found" };
        const receipt = await database.findProviderEventReceiptByDeliveryId(
          internalDeliveryId(organizationId, projectId, input.deliveryKey),
          organizationId,
        );
        if (!receipt || receipt.provider !== "manual" || receipt.source !== "manual.run")
          return { status: "run_not_found" };
        const run = (await database.findTriggerRunsByProviderEventReceiptId(receipt.id)).find(
          (r) =>
            r.organizationId === organizationId &&
            r.projectId === projectId &&
            r.configuredTriggerName === input.trigger,
        );
        return run ? read(organizationId, run.id) : { status: "run_not_found" };
      }),
    cancelRun: (authorization, input) =>
      guarded(async () => {
        const result = await database.cancelWorkflowRun(
          authorization.organizationId,
          input.runId,
          input.commandId,
          now(),
        );
        if (result.status !== "accepted") return result;
        // Persistence precedes acknowledgement and RPCs. Reconnect/startup recovery handles offline daemons.
        void recover(result.executionIds).catch((error) =>
          reportFailure(error, {
            operation: "run.cancel.reconcile",
            component: "public-operations",
          }),
        );
        const snapshot = await database.readWorkflowRun(authorization.organizationId, input.runId);
        return snapshot
          ? { status: "accepted", snapshot: await projectSnapshot(snapshot) }
          : { status: "run_not_found" };
      }),
  };
}

export function publicSnapshot(
  { run, steps, executions, cancellation }: WorkflowRunSnapshot,
  workspaces: ReadonlyMap<string, string> = new Map(),
): PublicRunSnapshot {
  return {
    runId: run.id,
    projectId: run.projectId,
    configurationRevisionId: run.configurationRevisionId,
    providerEventReceiptId: run.providerEventReceiptId,
    trigger: run.configuredTriggerName,
    status: run.status,
    terminal: run.status !== "running",
    failureReason: run.outcome === "accepted" ? run.failureReason : null,
    rejection: run.outcome === "rejected" ? run.rejection : null,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    cancellation: cancellation
      ? { commandId: cancellation.commandId, requestedAt: cancellation.requestedAt.toISOString() }
      : null,
    steps: steps.map((step) => {
      const execution = executions.find((e) => e.id === step.agentExecutionId);
      const disposition = execution?.hubActionDisposition ?? null;
      return {
        id: step.id,
        stepId: step.stepId,
        ordinal: step.ordinal,
        status: step.status,
        output: step.output ?? null,
        failureReason: step.failureReason,
        startedAt: step.startedAt?.toISOString() ?? null,
        completedAt: step.completedAt?.toISOString() ?? null,
        execution: execution
          ? {
              id: execution.id,
              status: execution.status,
              daemonId: execution.daemonId,
              machineId: execution.machineId,
              agentId: execution.daemonAgentId,
              sessionId: execution.agentSessionId,
              workspaceId: execution.agentSessionId
                ? (workspaces.get(execution.agentSessionId) ?? null)
                : null,
              startedAt: execution.startedAt.toISOString(),
              completedAt: execution.completedAt?.toISOString() ?? null,
              cleanup: {
                action: execution.hubAction,
                acknowledgedAt: execution.hubActionCompletedAt?.toISOString() ?? null,
                disposition,
                stopStatus: stopStatus(execution),
              },
            }
          : null,
      };
    }),
  };
}

export function runSnapshotEtag(snapshot: PublicRunSnapshot): string {
  return '"' + createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") + '"';
}

function stopStatus(
  execution: AgentExecutionRecord,
): "unconfirmed" | "archive_acknowledged" | "shared_session_released" | "not_started" {
  if (execution.hubActionCompletedAt === null) return "unconfirmed";
  if (execution.hubActionDisposition === "superseded") return "shared_session_released";
  if (execution.hubActionDisposition === "not_started") return "not_started";
  if (execution.hubActionDisposition === "applied" && execution.hubAction === "archive")
    return "archive_acknowledged";
  return "unconfirmed";
}
