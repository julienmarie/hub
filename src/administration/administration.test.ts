import { describe, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { z } from "zod";
import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { createAdministration, type AdministrativeOperations } from "./index.js";
import type { CommandRecord } from "./contracts.js";
import { ProblemSchema } from "../public-api/contracts.js";
import { ConfigurationRevisionConflictError } from "../db/errors.js";
import type { Database } from "../db/types.js";
const org = "org-one",
  credentialId = "key-one";
function auth(
  organizationId = org,
  scopes: readonly ApiKeyScope[] = [
    "projects:read",
    "configuration:install",
    "commands:read",
    "runs:cancel",
  ],
): OperationAuthenticator {
  return {
    async authorize(_request, scope) {
      return scopes.includes(scope)
        ? { status: "authorized", access: { kind: "apiKey", organizationId, credentialId, scopes } }
        : { status: "forbidden" };
    },
  };
}
function request(path: string, body?: unknown) {
  return new Request(
    `https://hub.test/api/v1/${path}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
}
const unusedOperations: AdministrativeOperations = {
  async cancelRun() {
    throw new Error("Unused cancelRun");
  },
  async dispatchManualRun() {
    throw new Error("Unused dispatchManualRun");
  },
  async installConfiguration() {
    throw new Error("Unused installConfiguration");
  },
};
const ReceiptSchema = z.object({ status: z.string() }).passthrough();
const ProjectPageSchema = z.object({
  projects: z.array(z.object({ id: z.string().uuid() })),
  nextCursor: z.string().uuid().nullable(),
});
describe("durable public administration", () => {
  it.each(["memory", "embedded"])(
    "activation CAS preserves a concurrent edit in %s storage",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "hub-configuration-cas-"));
      let runtime: Awaited<ReturnType<typeof embeddedDatabaseRuntime>> | undefined;
      try {
        let db: Database;
        if (kind === "embedded") {
          runtime = await embeddedDatabaseRuntime(root);
          await runtime.runtime.migrate();
          await runtime.runtime.query("insert into organization(id,name,slug) values($1,$2,$3)", [
            org,
            "One",
            "one",
          ]);
          db = createDatabase(runtime.runtime, runtime.locks);
        } else db = createMemoryDatabase();
        const project = await db.createProject({
          organizationId: org,
          slug: "cas",
          name: "CAS",
          createdByUserId: null,
        });
        const revisions = [];
        for (const rawYaml of ["first", "second", "third"]) {
          revisions.push(
            await db.insertProjectConfigurationRevision({
              projectId: project.id,
              sourceKind: "manual",
              sourceEvidence: {},
              rawYaml,
              normalizedConfiguration: {},
              validationErrors: null,
              contentHash: createHash("sha256").update(rawYaml).digest("hex"),
            }),
          );
        }
        const first = revisions[0]!,
          second = revisions[1]!,
          third = revisions[2]!;
        await db.activateProjectConfigurationRevision(project.id, first.id, [], null);
        const results = await Promise.allSettled([
          db.activateProjectConfigurationRevision(project.id, second.id, [], first.id),
          db.activateProjectConfigurationRevision(project.id, third.id, [], first.id),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        for (const result of results) {
          if (result.status === "rejected")
            expect(result.reason).toBeInstanceOf(ConfigurationRevisionConflictError);
        }
        const winner = results.find((r) => r.status === "fulfilled");
        expect((await db.findProjectById(project.id))?.activeConfigurationRevisionId).toBe(
          winner?.status === "fulfilled" ? winner.value.id : undefined,
        );
      } finally {
        await runtime?.runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("identifies only the credential organization, including during slug reuse", async () => {
    const db = createMemoryDatabase();
    const lookups: string[] = [];
    db.findOrganizationSlugById = async (id) => {
      lookups.push(id);
      return "one";
    };
    db.findOrganizationForOperator = async () => ({ id: org, name: "One", slug: "one" });
    const api = createAdministration(db, auth(), unusedOperations, null);
    expect(await (await api.handle(request("access"))).json()).toMatchObject({
      organizationId: org,
      organization: { id: org, name: "One", slug: "one" },
    });
    db.findOrganizationForOperator = async () => ({
      id: "another-org",
      name: "Private",
      slug: "one",
    });
    expect(await (await api.handle(request("access"))).json()).toMatchObject({
      organizationId: org,
      organization: null,
    });
    expect(lookups).toEqual([org, org]);
  });
  it("reports a configuration revision conflict as a failed receipt without overwriting it", async () => {
    const db = createMemoryDatabase();
    const project = await db.createProject({
      organizationId: org,
      slug: "cas-receipt",
      name: "CAS",
      createdByUserId: null,
    });
    const api = createAdministration(
      db,
      auth(),
      {
        ...unusedOperations,
        async installConfiguration(_access, input) {
          expect(input.expectedActiveRevision).toBeNull();
          throw new ConfigurationRevisionConflictError();
        },
      },
      null,
    );
    const command = {
      commandId: randomUUID(),
      type: "configuration.install",
      target: project.id,
      expectedRevision: null,
      args: { files: [{ path: ".paseo/hub.yaml", content: "name: cas-receipt" }] },
    };
    const receipt = ReceiptSchema.parse(
      await (await api.handle(request("commands", command))).json(),
    );
    expect(receipt.status).toBe("failed");
    expect(receipt["result"]).toEqual({ code: "revision_changed" });
    expect(await (await api.handle(request("commands", command))).json()).toEqual(receipt);
  });
  it("preserves canonical problem responses and request correlation", async () => {
    const db = createMemoryDatabase();
    const api = createAdministration(db, auth(), unusedOperations, null);
    const correlated = new Request("https://hub.test/api/v1/projects?limit=2", {
      headers: { "x-request-id": "client-request" },
    });
    const success = await api.handle(correlated);
    expect(success.headers.get("x-request-id")).toBe("client-request");
    const wrongMethod = await api.handle(new Request(correlated.url, { method: "DELETE" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(wrongMethod.headers.get("content-type")).toBe("application/problem+json");
    const problem = ProblemSchema.parse(await wrongMethod.json());
    expect(problem.requestId).toBe(wrongMethod.headers.get("x-request-id"));
    const unauthenticated = createAdministration(
      db,
      {
        async authorize() {
          return { status: "unauthorized" };
        },
      },
      unusedOperations,
      null,
    );
    const denied = await unauthenticated.handle(request("sessions"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    expect(ProblemSchema.parse(await denied.json()).code).toBe("unauthorized");
  });
  it("replays receipts, rejects changed bytes, and isolates organizations", async () => {
    const db = createMemoryDatabase(),
      api = createAdministration(db, auth(), unusedOperations, null);
    const command = {
      commandId: randomUUID(),
      type: "project.create",
      target: "example",
      expectedRevision: null,
      args: { name: "Example" },
    };
    const initial = await api.handle(request("commands", command));
    expect(initial.status).toBe(202);
    const receipt = ReceiptSchema.parse(await initial.json());
    expect(receipt.status).toBe("succeeded");
    expect(await (await api.handle(request("commands", command))).json()).toEqual(receipt);
    expect(
      (await api.handle(request("commands", { ...command, args: { name: "Changed" } }))).status,
    ).toBe(409);
    expect((await db.listProjectsForOrganization(org)).length).toBe(1);
    const other = createAdministration(db, auth("other"), unusedOperations, null);
    expect((await other.handle(request(`commands/${command.commandId}`))).status).toBe(404);
    const denied = createAdministration(db, auth(org, ["commands:read"]), unusedOperations, null);
    expect(
      (
        await denied.handle(
          request("commands", { ...command, commandId: randomUUID(), target: "forbidden" }),
        )
      ).status,
    ).toBe(403);
    expect((await db.listProjectsForOrganization(org)).length).toBe(1);
  });
  it("lost acknowledgements stay uncertain and queries never repeat effects", async () => {
    const db = createMemoryDatabase();
    let effects = 0;
    const operations: AdministrativeOperations = {
      ...unusedOperations,
      async cancelRun() {
        effects++;
        throw new Error("response lost after side effect");
      },
    };
    const api = createAdministration(db, auth(), operations, null),
      command = {
        commandId: randomUUID(),
        type: "run.cancel",
        target: randomUUID(),
        expectedRevision: null,
        args: {},
      };
    const receipt = ReceiptSchema.parse(
      await (await api.handle(request("commands", command))).json(),
    );
    expect(receipt.status).toBe("uncertain");
    await api.handle(request("commands", command));
    await api.handle(request(`commands/${command.commandId}`));
    expect(effects).toBe(1);
  });
  it("read-only queries cannot execute an admitted command after a restart", async () => {
    const db = createMemoryDatabase();
    const command = {
      commandId: randomUUID(),
      type: "run.cancel" as const,
      target: randomUUID(),
      expectedRevision: null,
      args: {},
    };
    const record: CommandRecord = {
      commandId: command.commandId,
      organizationId: org,
      credentialId,
      digest: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      request: command,
      status: "admitted",
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.admitAdministrativeCommand(record);
    let effects = 0;
    const api = createAdministration(
      db,
      auth(),
      {
        ...unusedOperations,
        async cancelRun() {
          effects++;
          return { status: "run_not_found" };
        },
      },
      null,
    );
    expect(
      ReceiptSchema.parse(await (await api.handle(request(`commands/${command.commandId}`))).json())
        .status,
    ).toBe("admitted");
    await api.handle(request("commands", command));
    expect(effects).toBe(0);
  });
  it("paginates a stable organization inventory without duplicates", async () => {
    const db = createMemoryDatabase();
    for (let i = 0; i < 5; i++)
      await db.createProject({
        organizationId: org,
        slug: `project-${i}`,
        name: `Project ${i}`,
        createdByUserId: null,
      });
    await db.createProject({
      organizationId: "other",
      slug: "private",
      name: "Private",
      createdByUserId: null,
    });
    const api = createAdministration(db, auth(), unusedOperations, null),
      ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = ProjectPageSchema.parse(
        await (
          await api.handle(request(`projects?limit=2${cursor ? `&cursor=${cursor}` : ""}`))
        ).json(),
      );
      ids.push(...page.projects.map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  });
  it("fences every session execution before daemon control and does not claim process exit", async () => {
    const db = createMemoryDatabase();
    const sessionId = randomUUID(),
      projectId = randomUUID(),
      daemonId = randomUUID();
    await db.saveAgentSession({
      id: sessionId,
      organizationId: org,
      projectId,
      daemonId,
      agentId: "agent",
      workspaceId: "workspace",
      continuationKey: "thread",
      compatibility: "same",
      tools: [],
      capabilityTokenHash: "private-hash",
      creationOptions: {
        provider: "codex",
        cwd: "/repo",
        env: { PRIVATE_KEY: "private-value" },
        toolPolicy: { preapproved: [] },
      },
    });
    let controls = 0;
    const connection: DaemonConnection = {
      agents: {
        async create() {
          throw new Error("unused");
        },
        async get() {
          return { id: "agent", workspaceId: "workspace", status: "idle" };
        },
        async send() {},
        async restore() {
          return true;
        },
        async watch() {
          return () => {};
        },
        async control() {
          controls++;
        },
      },
      async getProviderSnapshot() {
        throw new Error("unused");
      },
      async refreshProviderSnapshot() {},
      async validateAgentConfiguration() {
        return { valid: true };
      },
    };
    const api = createAdministration(
      db,
      auth(org, ["sessions:control", "sessions:read"]),
      unusedOperations,
      { connection: () => connection, updatePermissions() {}, async revoke() {} },
    );
    const command = {
      commandId: randomUUID(),
      type: "session.interrupt",
      target: sessionId,
      args: {},
      expectedRevision: null,
    };
    const receipt = ReceiptSchema.parse(
      await (await api.handle(request("commands", command))).json(),
    );
    expect(receipt.status).toBe("succeeded");
    expect(controls).toBe(1);
    expect(JSON.stringify(receipt)).toContain("unconfirmed");
    const inspect = await (await api.handle(request(`sessions/${sessionId}`))).text();
    expect(inspect).not.toContain("private-hash");
    expect(inspect).not.toContain("private-value");
    const execution = await db.insertAgentExecution({
      organizationId: org,
      projectId,
      machineId: null,
      configurationRevisionId: randomUUID(),
      triggerContext: {},
      outputContext: {},
      status: "spawning",
    });
    await db.attachExecutionToSession(execution.id, sessionId);
    const blocked = ReceiptSchema.parse(
      await (await api.handle(request("commands", { ...command, commandId: randomUUID() }))).json(),
    );
    expect(blocked.status).toBe("uncertain");
    expect(controls).toBe(1);
  });
  it("persists admission and outcome through an embedded database restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-admin-restart-"));
    let runtime = await embeddedDatabaseRuntime(root);
    const id = randomUUID(),
      command = {
        commandId: id,
        type: "project.create" as const,
        target: "example",
        args: { name: "Example" },
        expectedRevision: null,
      };
    try {
      await runtime.runtime.migrate();
      await runtime.runtime.query("insert into organization(id,name,slug) values($1,$2,$3)", [
        org,
        "One",
        "one",
      ]);
      let db = createDatabase(runtime.runtime, runtime.locks);
      const record: CommandRecord = {
        commandId: id,
        organizationId: org,
        credentialId,
        digest: "a".repeat(64),
        request: command,
        status: "admitted",
        result: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(await db.admitAdministrativeCommand(record)).toBe(true);
      await db.settleAdministrativeCommand(org, id, "admitted", "succeeded", { created: true });
      await runtime.runtime.close();
      runtime = await embeddedDatabaseRuntime(root);
      db = createDatabase(runtime.runtime, runtime.locks);
      expect((await db.readAdministrativeCommand(org, id))?.status).toBe("succeeded");
      expect(await db.admitAdministrativeCommand(record)).toBe(false);
      expect(await db.readAdministrativeCommand("other", id)).toBeUndefined();
    } finally {
      await runtime.runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
