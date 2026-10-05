import { z } from "zod";
const ProcessExitBase = z
  .object({
    kind: z.enum(["provider_group", "daemon_tree"]),
    groups: z.array(z.number().int().positive()).max(128).optional(),
    requestId: z.string().uuid(),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    provider: z.literal("codex"),
    pid: z.number().int().positive(),
    processGroupId: z.number().int().positive(),
    observedAt: z.string().datetime(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  })
  .strict();
export const ProcessExitSchema = ProcessExitBase.refine(
  (p) =>
    p.pid === p.processGroupId &&
    (p.kind === "daemon_tree"
      ? p.groups !== undefined &&
        p.groups.includes(p.pid) &&
        new Set(p.groups).size === p.groups.length
      : p.exitCode !== null || p.signal !== null),
);
export const ExecutionProcessExitSchema = ProcessExitBase.extend({
  executionId: z.string().uuid(),
  daemonId: z.string().uuid(),
  sessionId: z.string().uuid(),
})
  .strict()
  .refine(
    (p) =>
      p.pid === p.processGroupId &&
      (p.kind === "daemon_tree"
        ? p.groups !== undefined &&
          p.groups.includes(p.pid) &&
          new Set(p.groups).size === p.groups.length
        : p.exitCode !== null || p.signal !== null),
  );
export type ProcessExit = z.infer<typeof ProcessExitSchema>;
export interface ExecutionProcessExit extends ProcessExit {
  executionId: string;
  daemonId: string;
  sessionId: string;
}
