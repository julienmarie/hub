import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
extendZodWithOpenApi(z);

export const RunPathSchema = z.object({ runId: z.string().uuid() }).strict();
export const CancelRunRequestSchema = z
  .object({ commandId: z.string().uuid() })
  .strict()
  .openapi("CancelRunRequest");
export const ManualRunLookupSchema = z
  .object({
    projectSlug: z.string().min(1).max(100),
    trigger: z.string().min(1).max(200),
    deliveryKey: z.string().min(1).max(200),
  })
  .strict();
const timestamp = z.string().datetime({ offset: true });
const ExecutionSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["spawning", "running", "succeeded", "failed"]),
    daemonId: z.string().uuid().nullable(),
    machineId: z.string().uuid().nullable(),
    agentId: z.string().nullable(),
    sessionId: z.string().uuid().nullable(),
    startedAt: timestamp,
    completedAt: timestamp.nullable(),
    cleanup: z
      .object({
        action: z.enum(["interrupt", "archive"]).nullable(),
        acknowledgedAt: timestamp.nullable(),
        disposition: z.enum(["applied", "superseded", "not_started"]).nullable(),
        stopStatus: z.enum([
          "unconfirmed",
          "archive_acknowledged",
          "shared_session_released",
          "not_started",
        ]),
      })
      .strict(),
  })
  .strict();
export const RunSnapshotSchema = z
  .object({
    runId: z.string().uuid(),
    projectId: z.string().uuid(),
    configurationRevisionId: z.string().uuid(),
    providerEventReceiptId: z.string().uuid(),
    trigger: z.string(),
    status: z.enum(["running", "succeeded", "failed", "timed_out", "rejected"]),
    terminal: z.boolean(),
    failureReason: z.string().nullable(),
    rejection: z.unknown().nullable(),
    createdAt: timestamp,
    completedAt: timestamp.nullable(),
    cancellation: z
      .object({ commandId: z.string().uuid(), requestedAt: timestamp })
      .strict()
      .nullable(),
    steps: z.array(
      z
        .object({
          id: z.string().uuid(),
          stepId: z.string(),
          ordinal: z.number().int(),
          status: z.enum(["pending", "running", "succeeded", "skipped", "failed", "timed_out"]),
          output: z.unknown().nullable(),
          failureReason: z.string().nullable(),
          startedAt: timestamp.nullable(),
          completedAt: timestamp.nullable(),
          execution: ExecutionSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("RunSnapshot", {
    description:
      "Durable workflow state. Terminal workflow status and daemon archive acknowledgements are separate receipts; shared-session release does not prove termination.",
  });
export type PublicRunSnapshot = z.infer<typeof RunSnapshotSchema>;
