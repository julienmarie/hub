import { agentSessionLock } from "../agent-sessions/index.js";
import { ConfigurationRevisionConflictError, isDatabaseUnavailableError } from "../db/errors.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/types.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { PublicAuthorization, PublicOperations } from "../public-operations/types.js";
import type { ActiveDaemonRegistry } from "../daemons/registry.js";
import { publicSnapshot } from "../public-operations/run-lifecycle.js";
import { ProblemSchema } from "../public-api/contracts.js";
import {
  commandSchema,
  commandScope,
  pageSchema,
  publicCommand,
  type Command,
  type CommandRecord,
} from "./contracts.js";
export type AdministrativeOperations = Pick<
  PublicOperations,
  "cancelRun" | "dispatchManualRun" | "installConfiguration"
>;
export interface Administration {
  matches(path: string): boolean;
  handle(request: Request): Promise<Response>;
}
const route =
  /^\/api\/v1\/(access|commands(?:\/[^/]+)?|projects|runs|sessions(?:\/[^/]+(?:\/history)?)?|machines(?:\/[^/]+\/providers)?|projects\/[^/]+\/configuration)$/;
class AdministrativeRefusal extends Error {}
const problem = (status: number, code: string) =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sessionSummary(session: import("../agent-sessions/index.js").AgentSessionRecord) {
  return {
    id: session.id,
    projectId: session.projectId,
    daemonId: session.daemonId,
    agentId: session.agentId,
    workspaceId: session.workspaceId,
  };
}
export function createAdministration(
  db: Database,
  authenticator: OperationAuthenticator,
  operations: AdministrativeOperations,
  daemons: Pick<ActiveDaemonRegistry, "connection" | "updatePermissions" | "revoke"> | null,
): Administration {
  async function authenticate(
    request: Request,
    scope: ApiKeyScope,
  ): Promise<PublicAuthorization | Response> {
    const result = await authenticator.authorize(request, scope);
    if (result.status !== "authorized")
      return problem(result.status === "unauthorized" ? 401 : 403, result.status);
    return result.access;
  }
  async function execute(access: PublicAuthorization, command: Command): Promise<unknown> {
    const args = command.args;
    if (command.type === "run.cancel")
      return operations.cancelRun(access, {
        runId: z.string().uuid().parse(command.target),
        commandId: command.commandId,
      });
    if (command.type === "run.launch") {
      // Only a current revision may dispatch. The downstream delivery key is the durable command identity.
      return operations.dispatchManualRun(access, {
        projectSlug: command.target,
        expectedVersionId: z.string().uuid().parse(command.expectedRevision),
        trigger: z.string().min(1).max(200).parse(args["trigger"]),
        actor: "alma",
        deliveryKey: command.commandId,
        input: args["input"],
      });
    }
    if (command.type === "project.create") {
      const prior = await db.findProjectBySlugForOrganization(
        access.organizationId,
        command.target,
      );
      if (prior) throw new AdministrativeRefusal("project_exists");
      return db.createProject({
        organizationId: access.organizationId,
        slug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(100)
          .parse(command.target),
        name: z.string().min(1).max(200).parse(args["name"]),
        createdByUserId: null,
      });
    }
    if (command.type === "configuration.install") {
      const project = await db.findProjectForOrganization(
        access.organizationId,
        z.string().uuid().parse(command.target),
      );
      if (!project) throw new AdministrativeRefusal("target_not_found");
      if (project.activeConfigurationRevisionId !== command.expectedRevision)
        throw new AdministrativeRefusal("revision_changed");
      const files = z
        .array(
          z
            .object({ path: z.string().min(1).max(256), content: z.string().max(1_048_576) })
            .strict(),
        )
        .min(1)
        .max(128)
        .parse(args["files"]);
      return operations.installConfiguration(access, {
        projectSlug: project.slug,
        files,
        expectedActiveRevision: command.expectedRevision ?? null,
        expectedProjectId: project.id,
      });
    }
    if (command.type.startsWith("machine.")) return executeMachine(access, command);
    if (command.type.startsWith("session.")) return executeSession(access, command);
    // Unsupported operations are explicitly blocked; they cannot silently fall back to browser/private APIs.
    throw new AdministrativeRefusal("operation_unqualified");
  }
  async function executeMachine(access: PublicAuthorization, command: Command): Promise<unknown> {
    const args = command.args;
    const daemon = await db.findDaemonForOrganization(
      access.organizationId,
      z.string().uuid().parse(command.target),
    );
    if (!daemon) throw new AdministrativeRefusal("target_not_found");
    if (command.type === "machine.rename") {
      const result = await db.renameDaemonForOrganization(
        access.organizationId,
        daemon.id,
        z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(100)
          .parse(args["name"]),
      );
      if (!result || result.status === "slug_conflict")
        throw new AdministrativeRefusal("slug_conflict");
      return { id: result.id, slug: result.slug };
    }
    if (command.type === "machine.permissions") {
      const permissions = z.array(z.literal("hub.execute")).max(1).parse(args["permissions"]);
      const updated = await db.setDaemonPermissions(daemon.id, permissions);
      if (!updated) throw new AdministrativeRefusal("target_not_found");
      daemons?.updatePermissions(updated);
      return { id: updated.id, permissions: updated.permissions };
    }
    await db.revokeDaemon(daemon.id);
    await daemons?.revoke(daemon);
    return { id: daemon.id, revoked: true };
  }
  async function validateSupervisedMessage(
    access: PublicAuthorization,
    command: Command,
    session: import("../agent-sessions/index.js").AgentSessionRecord,
  ): Promise<void> {
    const args = command.args;
    // Workforce replies belong to the original execution, not an arbitrary new
    // turn on a session whose workflow has already finished or been cancelled.
    if (args["runId"] !== undefined || args["executionId"] !== undefined) {
      const runId = z.string().uuid().parse(args["runId"]);
      const executionId = z.string().uuid().parse(args["executionId"]);
      const snapshot = await db.readWorkflowRun(access.organizationId, runId);
      if (
        !snapshot ||
        snapshot.run.projectId !== session.projectId ||
        snapshot.run.status !== "running" ||
        snapshot.cancellation !== null
      )
        throw new AdministrativeRefusal("supervised_run_not_active");
      const execution = snapshot.executions.find((e) => e.id === executionId);
      if (
        !execution ||
        execution.agentSessionId !== session.id ||
        execution.daemonId !== session.daemonId ||
        execution.daemonAgentId !== session.agentId ||
        (execution.status !== "running" && execution.status !== "spawning")
      )
        throw new AdministrativeRefusal("supervised_execution_changed");
    }
  }
  async function executeSession(access: PublicAuthorization, command: Command): Promise<unknown> {
    const args = command.args;
    const session = await db.findAgentSession(z.string().uuid().parse(command.target));
    if (!session || session.organizationId !== access.organizationId)
      throw new AdministrativeRefusal("target_not_found");
    const connection = daemons?.connection(session.daemonId);
    if (!connection || !session.agentId || !session.workspaceId)
      throw new AdministrativeRefusal("daemon_offline");
    return db.withAdvisoryLock(agentSessionLock(session), async () => {
      if (command.type === "session.message") {
        await validateSupervisedMessage(access, command, session);
        await connection.agents.send(
          session.agentId!,
          command.commandId,
          z.string().min(1).max(16_384).parse(args["text"]),
        );
        return { sessionId: session.id, messageId: command.commandId, accepted: true };
      }
      if (command.type === "session.restore")
        return {
          sessionId: session.id,
          restored: await connection.agents.restore(session.workspaceId!),
        };
      // Fence all active workflow authority before requesting daemon control on a shared session.
      const executions = await db.listAgentSessionExecutions(session.id);
      for (const execution of executions.filter(
        (e) => e.status === "running" || e.status === "spawning",
      )) {
        if (!execution.workflowStepRunId) throw new Error("session_authority_not_fenced");
        const step = await db.findWorkflowStepRunById(execution.workflowStepRunId);
        if (!step || step.agentExecutionId !== execution.id)
          throw new Error("session_authority_not_fenced");
        const digest = createHash("sha256")
          .update(JSON.stringify(["session-control", command.commandId, step.triggerRunId]))
          .digest("hex");
        const cancellationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const result = await operations.cancelRun(access, {
          runId: step.triggerRunId,
          commandId: cancellationId,
        });
        if (result.status !== "accepted") throw new Error("session_authority_not_fenced");
      }
      if (
        (await db.listAgentSessionExecutions(session.id)).some(
          (e) => e.status === "running" || e.status === "spawning",
        )
      )
        throw new Error("session_authority_not_fenced");
      await connection.agents.control(
        session.agentId!,
        session.workspaceId!,
        command.type === "session.archive" ? "archive" : "interrupt",
      );
      return {
        sessionId: session.id,
        daemonAcknowledged: true,
        physicalTermination: "unconfirmed",
      };
    });
  }
  async function recover(request: Request, record: CommandRecord): Promise<CommandRecord> {
    return db.withAdvisoryLock(
      `administrative-command:${record.organizationId}:${record.commandId}`,
      async () => {
        const current = await db.readAdministrativeCommand(record.organizationId, record.commandId);
        if (!current) throw new Error("receipt_missing");
        if (current.status === "executing") {
          await db.settleAdministrativeCommand(
            record.organizationId,
            record.commandId,
            "executing",
            "uncertain",
            { code: "submission_unconfirmed" },
          );
        } else if (current.status === "admitted") {
          const access = await authenticate(request, commandScope(current.request));
          if (access instanceof Response || access.organizationId !== record.organizationId)
            return current;
          if (
            await db.settleAdministrativeCommand(
              record.organizationId,
              record.commandId,
              "admitted",
              "executing",
              null,
            )
          ) {
            try {
              const result = await execute(access, current.request);
              await db.settleAdministrativeCommand(
                record.organizationId,
                record.commandId,
                "executing",
                "succeeded",
                result,
              );
            } catch (error) {
              // Transport errors may follow an accepted effect. Preserve identity and require read-only reconciliation.
              let code = "outcome_unconfirmed";
              if (error instanceof AdministrativeRefusal) code = error.message;
              else if (error instanceof ConfigurationRevisionConflictError)
                code = "revision_changed";
              await db.settleAdministrativeCommand(
                record.organizationId,
                record.commandId,
                "executing",
                error instanceof AdministrativeRefusal ||
                  error instanceof z.ZodError ||
                  error instanceof ConfigurationRevisionConflictError
                  ? "failed"
                  : "uncertain",
                { code },
              );
            }
          }
        }
        return (await db.readAdministrativeCommand(record.organizationId, record.commandId))!;
      },
    );
  }
  async function submitCommand(request: Request): Promise<Response> {
    if (!request.headers.get("content-type")?.includes("application/json"))
      return problem(400, "invalid_request");
    const bytes = await boundedBody(request);
    if (bytes instanceof Response) return bytes;
    const command = commandSchema.parse(JSON.parse(bytes.toString("utf8")));
    const access = await authenticate(request, commandScope(command));
    if (access instanceof Response) return access;
    const digest = createHash("sha256").update(bytes).digest("hex"),
      time = new Date().toISOString();
    const created = await db.admitAdministrativeCommand({
      commandId: command.commandId,
      organizationId: access.organizationId,
      credentialId: access.credentialId,
      digest,
      request: command,
      status: "admitted",
      result: null,
      createdAt: time,
      updatedAt: time,
    });
    const record = (await db.readAdministrativeCommand(access.organizationId, command.commandId))!;
    if (record.digest !== digest || record.credentialId !== access.credentialId)
      return problem(409, "command_conflict");
    // Receipt persistence precedes execution. Same-key replays only observe the original effect.
    return response(
      publicCommand(created ? await recover(request, record) : record),
      created ? 202 : 200,
    );
  }
  async function readInventory(
    access: PublicAuthorization,
    path: string[],
    url: URL,
  ): Promise<Response> {
    const page = pageSchema.parse(Object.fromEntries(url.searchParams));
    let items: unknown[];
    if (path[0] === "sessions")
      items = (
        await db.listAdministrationSessions(
          access.organizationId,
          page.cursor,
          page.limit + 1,
          page.projectId,
        )
      ).map(sessionSummary);
    else if (path[0] === "runs")
      items = await Promise.all(
        (
          await db.listAdministrationRuns(
            access.organizationId,
            page.cursor,
            page.limit + 1,
            page.projectId,
          )
        ).map(async (r) =>
          publicSnapshot((await db.readWorkflowRun(access.organizationId, r.id))!),
        ),
      );
    else if (path[0] === "machines")
      items = (await db.listDaemonsForOrganization(access.organizationId)).map((d) => ({
        id: d.id,
        machineId: d.machineId,
        slug: d.slug,
        permissions: d.permissions,
        status: d.status,
        presence: d.presence,
        lastSeenAt: d.lastSeenAt,
        readiness:
          d.presence === "connected" && d.permissions.includes("hub.execute")
            ? "requires_qualification"
            : "blocked",
      }));
    else
      items = (await db.listProjectsForOrganization(access.organizationId))
        .filter((p) => p.status === "active")
        .map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
    if (path[0] === "machines" || path[0] === "projects")
      items = items
        .filter((i) => !page.cursor || itemIdentity(i) > page.cursor)
        .sort((a, b) => itemIdentity(a).localeCompare(itemIdentity(b)))
        .slice(0, page.limit + 1);
    const nextCursor = items.length > page.limit ? itemIdentity(items[page.limit - 1]) : null;
    return response({
      [path[0] === "projects" ? "projects" : "items"]: items.slice(0, page.limit),
      nextCursor,
    });
  }
  async function readConfiguration(
    access: PublicAuthorization,
    id: string | undefined,
  ): Promise<Response> {
    const project = await db.findProjectForOrganization(
      access.organizationId,
      z.string().uuid().parse(id),
    );
    if (!project) return problem(404, "not_found");
    const model = await db.projectConfigurationReadModel(project.id);
    return response({
      projectId: project.id,
      revisionId: model.activeRevision?.id ?? null,
      configuration: model.activeRevision?.normalizedConfiguration ?? null,
      authority: model.authority,
    });
  }
  async function readResource(
    access: PublicAuthorization,
    path: string[],
    url: URL,
  ): Promise<Response> {
    if (path[0] === "access") {
      const slug = await db.findOrganizationSlugById(access.organizationId);
      const organization =
        slug === undefined ? undefined : await db.findOrganizationForOperator(slug);
      // A concurrent rename/reused slug must never disclose another organization's identity.
      return response({
        organizationId: access.organizationId,
        organization: organization?.id === access.organizationId ? organization : null,
        scopes: access.scopes,
      });
    }
    if (path[0] === "commands") {
      const id = z.string().uuid().parse(path[1]);
      const record = await db.readAdministrativeCommand(access.organizationId, id);
      return record ? response(publicCommand(record)) : problem(404, "not_found");
    }
    if (path[0] === "sessions" && path.length > 1) {
      const session = await db.findAgentSession(z.string().uuid().parse(path[1]));
      if (!session || session.organizationId !== access.organizationId)
        return problem(404, "not_found");
      if (path[2] === "history") return problem(409, "canonical_history_not_qualified");
      return response(sessionSummary(session));
    }
    if (path[0] === "projects" && path[2] === "configuration")
      return readConfiguration(access, path[1]);
    if (path[0] === "machines" && path.length > 1) {
      const daemon = await db.findDaemonForOrganization(
        access.organizationId,
        z.string().uuid().parse(path[1]),
      );
      if (!daemon) return problem(404, "not_found");
      const connection = daemons?.connection(daemon.id);
      return connection
        ? response(await connection.getProviderSnapshot({}))
        : problem(409, "daemon_offline_or_unqualified");
    }
    return readInventory(access, path, url);
  }
  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname.slice("/api/v1/".length).split("/");
    try {
      if (path[0] === "commands" && request.method === "POST" && path.length === 1)
        return await submitCommand(request);
      if (request.method !== "GET") return problem(405, "method_not_allowed");
      const access = await authenticate(request, readScope(path));
      if (access instanceof Response) return access;
      return await readResource(access, path, url);
    } catch (error) {
      if (isDatabaseUnavailableError(error)) return problem(503, "storage_unavailable");
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return problem(400, "invalid_request");
      return problem(500, "internal_error");
    }
  }
  return {
    matches: (path) => route.test(path),
    async handle(request) {
      return administrativeResponse(request, await handleRequest(request));
    },
  };
}
async function administrativeResponse(request: Request, result: Response): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const headers = new Headers(result.headers);
  headers.set("x-request-id", requestId);
  if (result.status < 400) return new Response(result.body, { status: result.status, headers });
  const { code } = z.object({ code: z.string() }).parse(await result.json());
  headers.set("content-type", "application/problem+json");
  if (result.status === 401) headers.set("www-authenticate", "Bearer");
  if (result.status === 405)
    headers.set("allow", new URL(request.url).pathname === "/api/v1/commands" ? "POST" : "GET");
  return Response.json(
    ProblemSchema.parse({
      type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
      title: code.replaceAll("_", " "),
      status: result.status,
      detail:
        "The administrative operation could not be completed. Inspect the code and original command receipt.",
      code,
      requestId,
    }),
    { status: result.status, headers },
  );
}
function readScope(path: string[]): ApiKeyScope {
  if (path[0] === "commands") return "commands:read";
  if (path[0] === "runs") return "runs:read";
  if (path[0] === "sessions") return "sessions:read";
  if (path[0] === "machines") return "daemons:read";
  if (path.length > 1) return "configuration:read";
  return "projects:read";
}
async function boundedBody(request: Request): Promise<Buffer | Response> {
  const reader = request.body?.getReader();
  if (!reader) return problem(400, "invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 1_048_576) return problem(413, "request_too_large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
function itemIdentity(item: unknown): string {
  const record = z
    .object({ id: z.string().optional(), runId: z.string().optional() })
    .passthrough()
    .parse(item);
  return record.id ?? record.runId ?? "";
}
