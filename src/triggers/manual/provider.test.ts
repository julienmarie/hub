import { parseCompiledHubConfig } from "../../config/compiler.js";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { createManualRunProvider } from "./provider.js";

describe("manual invocation provider", () => {
  it("uses the same typed invocation evidence as message providers", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "manual-request",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["*"], inputs: { repo: "hub" } },
          inputs: {
            repo: { type: "string", choices: ["paseo", "hub"] },
            agent: { type: "string", default: "codex", choices: ["codex", "opus"] },
          },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
            },
          ],
        },
      ],
    });
    const provider = createManualRunProvider(() => store);
    const match = (
      await provider.match({
        providerEventReceiptId: "11111111-1111-4111-8111-111111111122",
        organizationId: "org-1",
        projectId: project.id,
        configurationRevisionId: revision.id,
        source: "manual.run",
        deliveryId: "manual-1",
        receivedAt: new Date(),
        payload: {
          trigger: "manual-request",
          actor: "operator",
          input: "repo=hub agent=opus investigate",
        },
      })
    )[0];

    assert.ok(match && typeof match !== "string");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: "repo=hub agent=opus investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("rejects a mismatched frozen revision before parsing an unusable daemon binding", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "manual-request",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["*"] },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "Handle it" }],
            },
          ],
        },
      ],
    });
    const compiled = parseCompiledHubConfig(revision.normalizedConfiguration);
    const malformed = {
      ...compiled,
      environments: compiled.environments.map((environment) =>
        environment.kind === "daemon"
          ? {
              kind: environment.kind,
              name: environment.name,
              daemon: environment.daemon,
              cwd: environment.cwd,
            }
          : environment,
      ),
    };
    const wrong = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: malformed,
      contentHash: "old-unresolved-daemon",
    });
    const result = await createManualRunProvider(() => store).match({
      providerEventReceiptId: "11111111-1111-4111-8111-111111111124",
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: wrong.id,
      source: "manual.run",
      deliveryId: "wrong-route",
      receivedAt: new Date(),
      payload: {
        trigger: "manual-request",
        actor: "alma",
        input: "Handle it",
        expectedVersionId: revision.id,
      },
    });
    assert.equal(result, "configuration_unavailable");
  });

  it("returns a rejected branch before resolving an unusable launch environment", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "manual-request",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["operator"] },
          inputs: { repo: { type: "string", choices: ["hub"] } },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
            },
          ],
        },
      ],
    });
    const provider = createManualRunProvider(() => store);
    const matches = await provider.match({
      providerEventReceiptId: "11111111-1111-4111-8111-111111111123",
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "manual.run",
      deliveryId: "manual-invalid-environment",
      receivedAt: new Date(),
      payload: {
        trigger: "manual-request",
        actor: "operator",
        input: "repo=unknown investigate",
      },
    });

    if (typeof matches === "string") throw new Error("expected rejected match");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.invocation.status, "rejected");
  });
});
