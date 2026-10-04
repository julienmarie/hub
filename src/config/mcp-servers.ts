import { z } from "zod";
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/\p{Cc}/u.test(value), "Control characters are not allowed");
export const AgentMcpServersSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .refine((name) => name !== "hub" && name !== "paseo", "Reserved Hub MCP namespace"),
    z
      .object({ type: z.literal("stdio"), command: text, args: z.array(text).max(64).optional() })
      .strict(),
  )
  .refine((servers) => Object.keys(servers).length <= 16, "Too many MCP servers");
export type AgentMcpServers = z.infer<typeof AgentMcpServersSchema>;
