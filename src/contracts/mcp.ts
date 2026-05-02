import { z } from "zod";

export const mcpUrlSchema = z
  .string()
  .regex(/^https?:\/\//, "mcps entries must be http:// or https:// URLs");

export const mcpAttachmentObjectSchema = z.object({
  url: mcpUrlSchema.describe("HTTP or HTTPS MCP server URL"),
  label: z.string().min(1).optional().describe("Optional human label for the MCP attachment"),
  headers: z
    .record(z.string())
    .optional()
    .describe("Optional inline HTTP headers sent when relay connects to this MCP server"),
  headers_env: z
    .record(z.string().min(1))
    .optional()
    .describe(
      "Optional HTTP header to environment-variable mapping. relay resolves the env vars at runtime and sends the resulting header values to the MCP server."
    ),
});

export const mcpAttachmentSchema = z.union([mcpUrlSchema, mcpAttachmentObjectSchema]);
export const mcpsSchema = z.array(mcpAttachmentSchema).optional();

export type McpAttachmentInput = z.infer<typeof mcpAttachmentSchema>;

export interface NormalizedMcpAttachment {
  url: string;
  label?: string;
  headers?: Record<string, string>;
  headers_env?: Record<string, string>;
}

export interface ResolvedMcpAttachment {
  url: string;
  label?: string;
  headers?: Record<string, string>;
}
