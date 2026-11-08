import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type ConfigOverrides } from "./config.js";
import { registerTools } from "./tools.js";
import { MAX_INPUT_ELEMENTS } from "./security.js";

export const SERVER_NAME = "invoiceninja-mcp";
export const SERVER_VERSION = "0.4.0";

/**
 * Build a fully-wired McpServer instance from the environment, with a request's overrides on top (HTTP transport).
 * Throws ConfigError when the address or token is missing or the address is refused.
 */
export function createServer(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  transport: "stdio" | "http" = "stdio",
): McpServer {
  const cfg = loadConfig(env, overrides);
  // Remote callers must never gain access to files on the server through this tool.
  if (cfg.allowWrites && (transport === "http" || !cfg.uploadDir)) cfg.disabledTools.add("in_upload_document");
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      maxToolInputElements: MAX_INPUT_ELEMENTS,
      instructions:
        "Tools for an Invoice Ninja (v5) instance. Read tools (in_list_*, in_get_*, " +
        "in_ping, in_outstanding_summary) are always available. Write tools (in_create_*, " +
        "in_update_*, in_invoice_action) exist only when the operator enabled writes; in safe mode the tools " +
        "that email, mark sent or paid, cancel, delete or record payments are left out, so documents stay drafts. " +
        "in_ping names the company the token belongs to. Invoice/quote creation needs a client_id and at least one line item. When updating a " +
        "client, always resend the full contacts array.",
    },
  );
  registerTools(server, cfg);
  return server;
}
