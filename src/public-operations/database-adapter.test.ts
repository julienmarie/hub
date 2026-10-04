import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";

describe("public manual-run project resolution", () => {
  it("prefers an organization trigger runtime and retains the legacy project fallback", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    await enrollTestDaemon(database, "org");
    const legacy = await database.createProject({
      organizationId: "org",
      name: "Default",
      slug: "default",
      createdByUserId: null,
    });
    const trigger = await new OrganizationTriggerStore(
      database,
      "org",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml(true),
      userId: null,
    });
    const repository = createDatabasePublicOperationRepository(database);

    assert.deepEqual(await repository.resolveManualRunProject("org", "deploy", "default"), {
      status: "resolved",
      id: trigger.runtimeProjectId,
    });
    const pinned = await database.insertProjectConfigurationRevision({
      projectId: legacy.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: {},
      contentHash: "pinned",
    });
    assert.deepEqual(
      await repository.resolveManualRunProject(
        "org",
        "deploy",
        "default",
        pinned.id,
        "pinned-delivery",
      ),
      { status: "resolved", id: legacy.id },
    );
    // Old accepted deliveries retain their original route even after routing is fixed.
    const runtimeRevision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(runtimeRevision);
    assert.deepEqual(
      await repository.resolveManualRunProject(
        "org",
        "deploy",
        "default",
        runtimeRevision.id,
        "organization-delivery",
      ),
      { status: "resolved", id: trigger.runtimeProjectId },
    );
    const { internalDeliveryId } = await import("./index.js");
    await database.persistManualEvent({
      organizationId: "org",
      projectId: trigger.runtimeProjectId,
      source: "manual.run",
      deliveryId: internalDeliveryId("org", trigger.runtimeProjectId, "old-delivery"),
      payload: { expectedVersionId: pinned.id },
      receivedAt: new Date(),
    });
    assert.deepEqual(
      await repository.resolveManualRunProject(
        "org",
        "deploy",
        "default",
        pinned.id,
        "old-delivery",
      ),
      { status: "resolved", id: trigger.runtimeProjectId },
    );
    assert.deepEqual(await repository.resolveManualRunProject("org", "legacy", "default"), {
      status: "resolved",
      id: legacy.id,
    });
  });

  it("does not fall through to a legacy project when the organization trigger is disabled", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    await enrollTestDaemon(database, "org");
    await database.createProject({
      organizationId: "org",
      name: "Default",
      slug: "default",
      createdByUserId: null,
    });
    await new OrganizationTriggerStore(database, "org", acceptingAgentValidator()).save({
      yaml: triggerYaml(false),
      userId: null,
    });

    assert.deepEqual(
      await createDatabasePublicOperationRepository(database).resolveManualRunProject(
        "org",
        "deploy",
        "default",
      ),
      { status: "disabled" },
    );
  });
});

function triggerYaml(enabled: boolean): string {
  return `name: deploy
enabled: ${String(enabled)}
on:
  manual.run: {}
run:
  target: { daemon: daemon-10000000, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;
}
