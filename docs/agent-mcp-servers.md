# Task MCP servers

A Hub agent can declare optional `mcp_servers` separately from its native
provider `options`. The configuration uses stdio servers with explicit command
and argument arrays; Hub passes these to the enrolled daemon's native MCP
configuration. No provider-specific configuration override is needed.

```yaml
agents:
  worker:
    provider: codex
    mcp_servers:
      task:
        type: stdio
        command: /opt/task-worker
        args: [mcp, --capability, /workspace/task-capability.json]
```

Provision private capability files separately in the assigned workspace.
Do not put credentials in authored configuration. The fields persist with the
exact compiled configuration and launch intent across restart. `hub` and
`paseo` are reserved namespaces; Hub retains its execution-specific completion
channel. This initial contract permits at most16 stdio servers and64 bounded
arguments per server, without environment overrides or HTTP credential headers.
Provider settings, permission mode, and Hub output authority stay explicit.
