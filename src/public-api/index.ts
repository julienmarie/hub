import type { RunLifecycleResult } from "../public-operations/types.js";
import { RunSnapshotSchema } from "./run-contracts.js";
import { runSnapshotEtag } from "../public-operations/run-lifecycle.js";
import { randomUUID } from "node:crypto";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { reportFailure } from "../failures/index.js";
import type {
  DispatchManualRunResult,
  InstallConfigurationResult,
  InstallTriggerResult,
  IssueEnrollmentTokenResult,
  ListProjectsResult,
  ListTriggersResult,
  ListConfigurationResourcesResult,
  ListSetupResourcesResult,
  PublicAuthorization,
  PublicOperations,
  ValidateConfigurationResult,
  ValidateTriggerResult,
} from "../public-operations/index.js";
import {
  DispatchedManualRunSchema,
  EnrollmentTokenSchema,
  InstalledConfigurationSchema,
  InstalledTriggerSchema,
  ProjectListSchema,
  TriggerListSchema,
  ConfigurationResourcesSchema,
  SetupResourcesSchema,
  ProblemSchema,
  ValidatedConfigurationSchema,
  ValidatedTriggerSchema,
  type Problem,
} from "./contracts.js";
import { publicOpenApiDocument } from "./openapi.js";
import {
  publicOperation,
  publicOperationManifest,
  type PublicOperationId,
  type PublicOperationDefinition,
} from "./operation-manifest.js";

export type { PublicOperationId } from "./operation-manifest.js";

type PublicOperationResult =
  | RunLifecycleResult
  | ValidateTriggerResult
  | InstallTriggerResult
  | ListTriggersResult
  | ListProjectsResult
  | ListConfigurationResourcesResult
  | ListSetupResourcesResult
  | ValidateConfigurationResult
  | InstallConfigurationResult
  | DispatchManualRunResult
  | IssueEnrollmentTokenResult;

export interface PublicApi {
  handle(request: Request): Promise<Response>;
  handleOperation(id: PublicOperationId, request: Request): Promise<Response>;
  openapi(): Response;
}

export type PublicApiComposition =
  | { status: "enabled"; authenticator: OperationAuthenticator }
  | { status: "unavailable" };

export function createPublicApi(
  composition: PublicApiComposition,
  operations: PublicOperations | null,
): PublicApi {
  if (composition.status === "enabled" && operations === null) {
    throw new Error("enabled public API requires application operations");
  }
  return {
    handle(request) {
      const url = new URL(request.url);
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      const pathRoutes = publicOperationManifest.filter(
        (route) => matchRoute(route.path, url.pathname) !== undefined,
      );
      if (pathRoutes.length === 0) {
        return Promise.resolve(
          problem(
            requestId,
            404,
            "not_found",
            "Not found",
            "No canonical API route matches this path.",
          ),
        );
      }
      const route = pathRoutes.find(
        (candidate) => candidate.method.toUpperCase() === request.method.toUpperCase(),
      );
      if (route === undefined) {
        const response = problem(
          requestId,
          405,
          "method_not_allowed",
          "Method not allowed",
          "Use one of the methods listed in the Allow response header.",
        );
        response.headers.set(
          "allow",
          pathRoutes.map(({ method }) => method.toUpperCase()).join(", "),
        );
        return Promise.resolve(response);
      }
      return executeSafely(route.id, request, requestId, composition, operations);
    },
    handleOperation(id, request) {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      return executeSafely(id, request, requestId, composition, operations);
    },
    openapi() {
      return Response.json(publicOpenApiDocument, {
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  };
}

async function executeSafely(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  composition: PublicApiComposition,
  operations: PublicOperations | null,
): Promise<Response> {
  try {
    if (composition.status === "unavailable" || operations === null) {
      return problem(
        requestId,
        503,
        "infrastructure_unavailable",
        "Service unavailable",
        "Public API authentication or storage is currently unavailable.",
      );
    }
    return await execute(id, request, requestId, composition.authenticator, operations);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: `public-api.${id}`,
        component: "public-api",
        requestId,
        status: isDatabaseUnavailableError(error) ? 503 : 500,
      },
      { status: isDatabaseUnavailableError(error) ? 503 : 500 },
    );
    if (isDatabaseUnavailableError(error)) return infrastructureProblem(requestId);
    return problem(
      requestId,
      500,
      "internal_error",
      "Internal server error",
      "The operation failed unexpectedly. Contact the Hub operator with the request ID.",
    );
  }
}

async function execute(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  authenticator: OperationAuthenticator,
  operations: PublicOperations,
): Promise<Response> {
  const definition = publicOperation(id);
  const scope = definition.scope;
  let authorization;
  try {
    authorization = await authenticator.authorize(request, scope);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return problem(
      requestId,
      503,
      "authentication_unavailable",
      "Authentication unavailable",
      "Bearer-credential authentication is currently unavailable. Retry the request later.",
    );
  }
  if (authorization.status === "unauthorized") {
    return problem(
      requestId,
      401,
      "unauthorized",
      "Authentication required",
      "Provide an active Paseo organization credential in the Authorization: Bearer header.",
    );
  }
  if (authorization.status === "forbidden") {
    return problem(
      requestId,
      403,
      "insufficient_scope",
      "Insufficient scope",
      `This operation requires the ${scope} scope.`,
    );
  }
  const access: PublicAuthorization = authorization.access;
  let input: unknown;
  if (definition.requestSchema !== undefined) {
    const parsedBody = await readJson(request);
    if (!parsedBody.success) {
      return problem(
        requestId,
        400,
        "invalid_json",
        "Invalid JSON",
        "Send a JSON request body using Content-Type: application/json.",
      );
    }
    const parsed = definition.requestSchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return validationProblem(requestId, parsed.error.issues);
    }
    input = parsed.data;
  }
  if (definition.paramsSchema) {
    const parsed = definition.paramsSchema.safeParse(
      matchRoute(definition.path, new URL(request.url).pathname),
    );
    if (!parsed.success) return validationProblem(requestId, parsed.error.issues);
    input = { ...(typeof input === "object" && input !== null ? input : {}), ...parsed.data };
  }
  if (definition.querySchema) {
    const parameters = new URL(request.url).searchParams;
    const values: Record<string, string> = {};
    for (const [key, value] of parameters) {
      if (key in values)
        return problem(
          requestId,
          400,
          "invalid_request",
          "Invalid request",
          "Lookup parameters must occur once.",
        );
      values[key] = value;
    }
    const parsed = definition.querySchema.safeParse(values);
    if (!parsed.success) return validationProblem(requestId, parsed.error.issues);
    input = parsed.data;
  }
  const result = await definition.invoke(operations, access, input);
  if (definition.resultMapping === "run-lifecycle") {
    if (!isRunLifecycleResult(result)) throw new Error("invalid run lifecycle result");
    return runLifecycleResponse(requestId, request, result);
  }

  if (definition.resultMapping === "triggers") {
    if (!isTriggersResult(result)) throw new Error("invalid triggers operation result");
    return triggersResponse(requestId, result);
  }
  return operationResponse(definition.resultMapping, requestId, result);
}

function operationResponse(
  mapping: Exclude<PublicOperationDefinition["resultMapping"], "triggers">,
  requestId: string,
  result: PublicOperationResult,
): Response {
  switch (mapping) {
    case "run-lifecycle":
      throw new Error("run lifecycle requires the authorized request");
    case "trigger-validation":
      if (!isTriggerValidationResult(result)) throw new Error("invalid trigger validation result");
      return triggerValidationResponse(requestId, result);
    case "trigger-installation":
      if (!isTriggerInstallationResult(result)) {
        throw new Error("invalid trigger installation result");
      }
      return triggerInstallationResponse(requestId, result);
    case "projects":
      if (!isProjectsResult(result)) throw new Error("invalid projects operation result");
      return projectsResponse(requestId, result);
    case "configuration-resources":
      if (!isConfigurationResourcesResult(result))
        throw new Error("invalid configuration resources operation result");
      return configurationResourcesResponse(requestId, result);
    case "setup-resources":
      if (!isSetupResourcesResult(result))
        throw new Error("invalid setup resources operation result");
      return setupResourcesResponse(requestId, result);
    case "validation":
      if (!isValidationResult(result)) throw new Error("invalid validation operation result");
      return validationResponse(requestId, result);
    case "configuration":
      if (!isInstallationResult(result)) throw new Error("invalid configuration operation result");
      return installationResponse(requestId, result);
    case "manual-run":
      if (!isManualRunResult(result)) throw new Error("invalid manual-run operation result");
      return manualRunResponse(requestId, result);
    case "enrollment-token":
      if (!isEnrollmentResult(result)) throw new Error("invalid enrollment operation result");
      return enrollmentResponse(requestId, result);
  }
  return assertNever(mapping);
}

function triggersResponse(requestId: string, result: ListTriggersResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, TriggerListSchema, { triggers: result.triggers })
    : infrastructureProblem(requestId);
}

function triggerValidationResponse(requestId: string, result: ValidateTriggerResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedTriggerSchema, { name: result.name, valid: true });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function triggerInstallationResponse(requestId: string, result: InstallTriggerResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledTriggerSchema, {
        triggerId: result.triggerId,
        name: result.name,
        revisionId: result.revisionId,
        version: result.version,
        active: true,
      });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML and submit it again.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function projectsResponse(requestId: string, result: ListProjectsResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, ProjectListSchema, { projects: result.projects })
    : infrastructureProblem(requestId);
}

function configurationResourcesResponse(
  requestId: string,
  result: ListConfigurationResourcesResult,
): Response {
  return result.status === "listed"
    ? success(requestId, 200, ConfigurationResourcesSchema, {
        daemons: result.daemons,
        github: result.github,
        discord: result.discord,
        slack: result.slack,
        linear: result.linear,
      })
    : infrastructureProblem(requestId);
}

function setupResourcesResponse(requestId: string, result: ListSetupResourcesResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, SetupResourcesSchema, {
        github: result.github,
        discord: result.discord,
        slack: result.slack,
      })
    : infrastructureProblem(requestId);
}

function validationResponse(requestId: string, result: ValidateConfigurationResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedConfigurationSchema, {
        projectSlug: result.projectSlug,
        valid: true,
        ...(result.wouldCreateProject === true ? { wouldCreateProject: true } : {}),
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        "See issues for configuration errors.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

async function readJson(
  request: Request,
): Promise<{ success: true; value: unknown } | { success: false }> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { success: false };
  }
  try {
    return { success: true, value: await request.json() };
  } catch {
    return { success: false };
  }
}

function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return problem(
    requestId,
    400,
    "invalid_request",
    "Invalid request",
    "The request body contains invalid fields.",
    issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  );
}

function installationResponse(requestId: string, result: InstallConfigurationResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledConfigurationSchema, {
        projectSlug: result.projectSlug,
        versionId: result.versionId,
        version: result.version,
        active: result.active,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files and submit them again.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        `Configuration revision ${result.versionId} was recorded but not activated.`,
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function manualRunResponse(requestId: string, result: DispatchManualRunResult): Response {
  switch (result.status) {
    case "dispatched":
      return success(requestId, 200, DispatchedManualRunSchema, {
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "actor_forbidden":
      return problem(
        requestId,
        403,
        "actor_forbidden",
        "Actor forbidden",
        "The configured manual trigger does not allow this actor.",
      );
    case "configuration_not_found":
      return problem(
        requestId,
        404,
        "configuration_not_found",
        "Configuration not found",
        "The requested configuration revision is not available.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "The active configuration has no matching manual trigger.",
      );
    case "expected_configuration_not_current":
      return problem(
        requestId,
        409,
        "configuration_changed",
        "Configuration changed",
        "expectedVersionId is not the configuration version selected for this delivery.",
      );
    case "daemon_offline":
      return problem(
        requestId,
        409,
        "daemon_offline",
        "Daemon offline",
        "The selected daemon is not connected. Reconnect it before retrying.",
      );
    case "invalid_input":
      return problem(
        requestId,
        400,
        "invalid_input",
        "Invalid trigger input",
        `Run ${result.triggerRunId} rejected the submitted input.`,
        result.issues,
      );
    case "dispatch_conflict":
      return problem(
        requestId,
        409,
        "dispatch_conflict",
        "Run not dispatched",
        "The durable event exists but no matching run is available yet. Retry with the same deliveryKey.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function enrollmentResponse(requestId: string, result: IssueEnrollmentTokenResult): Response {
  switch (result.status) {
    case "issued":
      return success(requestId, 201, EnrollmentTokenSchema, {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    case "credential_revoked":
      return problem(
        requestId,
        401,
        "unauthorized",
        "Authentication required",
        "The organization credential was revoked before the enrollment token could be issued.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function infrastructureProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "infrastructure_unavailable",
    "Service unavailable",
    "The operation could not reach durable storage. Retry the request later.",
  );
}

function success(
  requestId: string,
  status: number,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): Response {
  return Response.json(schema.parse(value), { status, headers: { "x-request-id": requestId } });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
): Response {
  const body: Problem = ProblemSchema.parse({
    type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
    title,
    status,
    detail,
    code,
    requestId,
    ...(issues === undefined ? {} : { issues }),
  });
  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
  });
}

function isInstallationResult(result: PublicOperationResult): result is InstallConfigurationResult {
  return [
    "installed",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isTriggerValidationResult(result: PublicOperationResult): result is ValidateTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "valid" && "name" in result)
  );
}

function isTriggerInstallationResult(
  result: PublicOperationResult,
): result is InstallTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "installed" && "triggerId" in result)
  );
}

function isProjectsResult(result: PublicOperationResult): result is ListProjectsResult {
  return ["listed", "infrastructure_unavailable"].includes(result.status);
}

function isTriggersResult(result: PublicOperationResult): result is ListTriggersResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "triggers" in result)
  );
}

function isConfigurationResourcesResult(
  result: PublicOperationResult,
): result is ListConfigurationResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "daemons" in result)
  );
}

function isSetupResourcesResult(result: PublicOperationResult): result is ListSetupResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "github" in result)
  );
}

function isValidationResult(result: PublicOperationResult): result is ValidateConfigurationResult {
  return [
    "valid",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isManualRunResult(result: PublicOperationResult): result is DispatchManualRunResult {
  return [
    "dispatched",
    "project_not_found",
    "actor_forbidden",
    "daemon_offline",
    "expected_configuration_not_current",
    "configuration_not_found",
    "trigger_not_found",
    "invalid_input",
    "dispatch_conflict",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isEnrollmentResult(result: PublicOperationResult): result is IssueEnrollmentTokenResult {
  return ["issued", "credential_revoked", "infrastructure_unavailable"].includes(result.status);
}

export { publicOpenApiDocument } from "./openapi.js";
export { publicOperationManifest } from "./operation-manifest.js";
export * from "./contracts.js";

function matchRoute(template: string, pathname: string): Record<string, string> | undefined {
  const expected = template.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i]!;
    if (segment.startsWith("{") && segment.endsWith("}")) {
      params[segment.slice(1, -1)] = actual[i]!;
    } else if (segment !== actual[i]) return undefined;
  }
  return params;
}

function runLifecycleResponse(
  requestId: string,
  request: Request,
  result: RunLifecycleResult,
): Response {
  if (result.status === "found" || result.status === "accepted") {
    const snapshot = RunSnapshotSchema.parse(result.snapshot);
    const etag = runSnapshotEtag(snapshot);
    const headers = { "x-request-id": requestId, "cache-control": "private, no-store", etag };
    if (
      request.method === "GET" &&
      request.headers
        .get("if-none-match")
        ?.split(",")
        .some((value) => value.trim() === etag || value.trim() === "*")
    )
      return new Response(null, { status: 304, headers });
    return Response.json(snapshot, { status: result.status === "accepted" ? 202 : 200, headers });
  }
  if (result.status === "infrastructure_unavailable" || result.status === "operation_unavailable")
    return infrastructureProblem(requestId);
  if (result.status === "run_not_found")
    return problem(
      requestId,
      404,
      result.status,
      "Run not found",
      "No matching durable run exists in this organization.",
    );
  return problem(
    requestId,
    409,
    result.status,
    "Cancellation conflict",
    result.status === "run_terminal"
      ? "The workflow was already terminal before cancellation."
      : "Retry cancellation using the original commandId.",
  );
}

function isRunLifecycleResult(result: PublicOperationResult): result is RunLifecycleResult {
  return [
    "found",
    "accepted",
    "run_not_found",
    "run_terminal",
    "command_conflict",
    "operation_unavailable",
    "infrastructure_unavailable",
  ].includes(result.status);
}
