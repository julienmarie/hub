import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { commandSchema, pageSchema } from "./contracts.js";
export function registerAdministrationApi(registry: OpenAPIRegistry): void {
  const receipt = z
    .object({
      commandId: z.string().uuid(),
      type: z.string(),
      target: z.string(),
      requestDigest: z.string(),
      status: z.enum(["admitted", "executing", "succeeded", "failed", "uncertain"]),
      result: z.unknown(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict();
  const paginated = z
    .object({ items: z.array(z.unknown()), nextCursor: z.string().uuid().nullable() })
    .strict();
  const paths = [
    ["/api/v1/access", "projects:read", "Inspect credential organization and scopes"],
    ["/api/v1/runs", "runs:read", "List canonical workflow run snapshots"],
    ["/api/v1/sessions", "sessions:read", "List Hub-tracked sessions"],
    [
      "/api/v1/sessions/{sessionId}",
      "sessions:read",
      "Inspect a tracked session without disclosing creation credentials",
    ],
    [
      "/api/v1/sessions/{sessionId}/history",
      "sessions:read",
      "Read canonical history when the daemon is qualified; otherwise returns an explicit blocker",
    ],
    [
      "/api/v1/machines",
      "daemons:read",
      "List enrolled machines, presence and qualification blockers",
    ],
    [
      "/api/v1/machines/{machineId}/providers",
      "daemons:read",
      "Read native provider capabilities on a connected enrolled daemon",
    ],
    [
      "/api/v1/projects/{projectId}/configuration",
      "configuration:read",
      "Read current configuration and exact revision",
    ],
    [
      "/api/v1/commands/{commandId}",
      "commands:read",
      "Observe a durable command without dispatching an effect",
    ],
  ];
  for (const [path, scope, summary] of paths) {
    if (!path || !scope || !summary) continue;
    registry.registerPath({
      method: "get",
      path,
      operationId: `administration_${path.replaceAll(/[^a-zA-Z]/g, "_")}`,
      summary,
      description: `Requires ${scope}. Reads require no running milestone. A workflow terminal receipt does not confirm physical termination.`,
      tags: ["Administration"],
      security: [{ bearerAuth: [] }],
      "x-required-scopes": [scope],
      ...requestForPath(path),
      responses: {
        200: {
          description: "Authorized result",
          content: {
            "application/json": {
              schema: schemaForPath(path, receipt, paginated),
            },
          },
        },
        400: { description: "Invalid request" },
        401: { description: "Authentication required" },
        403: { description: "Insufficient scope" },
        404: { description: "Resource not in this organization" },
        409: { description: "Daemon offline or capability unqualified" },
        503: { description: "Storage unavailable" },
      },
    });
  }
  registry.registerPath({
    method: "post",
    path: "/api/v1/commands",
    operationId: "submitAdministrativeCommand",
    summary: "Admit a durable administrative command",
    description:
      "Persists credential identity, exact request digest, target and outcome before acknowledgement. Same identity and bytes replay the receipt; conflicts fail. Required scope depends on type: runs:dispatch, runs:cancel, sessions:control, configuration:install or daemons:manage. Uncertain submission is never permission to repeat. Enrollment credentials use protected provisioning.",
    tags: ["Administration"],
    security: [{ bearerAuth: [] }],
    "x-required-scopes": [
      "runs:dispatch",
      "runs:cancel",
      "sessions:control",
      "configuration:install",
      "daemons:manage",
    ],
    request: {
      body: { required: true, content: { "application/json": { schema: commandSchema } } },
    },
    responses: {
      202: {
        description: "Durable command receipt",
        content: { "application/json": { schema: receipt } },
      },
      200: {
        description: "Existing command receipt",
        content: { "application/json": { schema: receipt } },
      },
      400: { description: "Invalid request" },
      401: { description: "Authentication required" },
      403: { description: "Insufficient scope" },
      409: { description: "Conflicting identity" },
      413: { description: "Request exceeds 1 MiB" },
      503: { description: "Storage unavailable" },
    },
  });
}

function requestForPath(path: string) {
  if (path.endsWith("runs") || path.endsWith("sessions") || path.endsWith("machines"))
    return { request: { query: pageSchema } };
  if (path.includes("{"))
    return {
      request: {
        params: z
          .object(
            Object.fromEntries(
              [...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], z.string().uuid()]),
            ),
          )
          .strict(),
      },
    };
  return {};
}
function schemaForPath(path: string, receipt: z.ZodType, paginated: z.ZodType): z.ZodType {
  if (path.includes("commands/")) return receipt;
  if (path.endsWith("access"))
    return z
      .object({
        organizationId: z.string(),
        organization: z
          .object({ id: z.string(), name: z.string(), slug: z.string() })
          .strict()
          .nullable(),
        scopes: z.array(z.string()),
      })
      .strict();
  if (path.includes("{")) return z.unknown();
  return paginated;
}
