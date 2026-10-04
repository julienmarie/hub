import assert from "node:assert/strict";
import { it } from "vitest";
import { AgentMcpServersSchema } from "./mcp-servers.js";
import { compileHubBundle } from "./bundle.js";
import { parseCompiledHubConfig } from "./compiler.js";
it("retains task MCP configuration through compilation and persisted restart parsing", () => {
  const mcp_servers = {
    alma_workforce: {
      type: "stdio",
      command: "/opt/alma-worker",
      args: ["mcp", "--capability", "/workspace/capability.json"],
    },
  };
  const bundle = compileHubBundle([
    {
      path: ".paseo/hub.yml",
      content: JSON.stringify({
        environments: { worker: { kind: "daemon", daemon: "worker", cwd: "/workspace" } },
        agents: { worker: { provider: "codex", mcp_servers } },
      }),
    },
    {
      path: ".paseo/workflows/check.yml",
      content: JSON.stringify({
        name: "check",
        on: "manual.run",
        max_runtime: "10m",
        steps: [
          {
            id: "execute",
            environment: "worker",
            agent: "worker",
            max_runtime: "10m",
            idle_timeout: "10m",
            prompt: [{ text: "Check" }],
          },
        ],
      }),
    },
  ]);
  const restored = parseCompiledHubConfig(JSON.parse(JSON.stringify(bundle.configuration)));
  assert.deepEqual(bundle.agentValidationTargets[0]?.agent.mcp_servers, mcp_servers);
  assert.deepEqual(restored.triggers[0]?.steps[0]?.agent, { provider: "codex", mcp_servers });
});
it("rejects reserved namespaces, unsupported transports and unbounded arguments", () => {
  const server = { type: "stdio", command: "/opt/worker" };
  assert.equal(AgentMcpServersSchema.safeParse({ hub: server }).success, false);
  assert.equal(AgentMcpServersSchema.safeParse({ paseo: server }).success, false);
  assert.equal(
    AgentMcpServersSchema.safeParse({ worker: { type: "http", url: "https://example.com" } })
      .success,
    false,
  );
  assert.equal(
    AgentMcpServersSchema.safeParse({ worker: { ...server, args: Array(65).fill("x") } }).success,
    false,
  );
  assert.equal(
    AgentMcpServersSchema.safeParse({ worker: { ...server, command: "bad\ncommand" } }).success,
    false,
  );
});
