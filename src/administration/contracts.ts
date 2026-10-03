import { z } from "zod";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
export const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict();
export const commandSchema = z
  .object({
    commandId: z.string().uuid(),
    type: z.enum([
      "run.launch",
      "run.cancel",
      "session.message",
      "session.interrupt",
      "session.archive",
      "session.restore",
      "project.create",
      "project.archive",
      "configuration.install",
      "workflow.enable",
      "machine.rename",
      "machine.permissions",
      "machine.revoke",
    ]),
    target: z.string().min(1).max(256),
    expectedRevision: z.string().nullable().optional(),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export interface CommandRecord {
  commandId: string;
  organizationId: string;
  credentialId: string;
  digest: string;
  request: Command;
  status: "admitted" | "executing" | "succeeded" | "failed" | "uncertain";
  result: unknown;
  createdAt: string;
  updatedAt: string;
}
export function commandScope(command: Command): ApiKeyScope {
  if (command.type.startsWith("machine.")) return "daemons:manage";
  if (command.type.startsWith("session.")) return "sessions:control";
  if (command.type === "run.launch") return "runs:dispatch";
  if (command.type === "run.cancel") return "runs:cancel";
  return "configuration:install";
}
export function publicCommand(record: CommandRecord) {
  return {
    commandId: record.commandId,
    type: record.request.type,
    target: record.request.target,
    requestDigest: record.digest,
    status: record.status,
    result: record.result,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
