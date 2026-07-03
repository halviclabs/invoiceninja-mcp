#!/usr/bin/env node
/**
 * stdio transport entry point.
 * Use this for Claude Desktop and Claude Code (local subprocess over stdio).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never log to stdout on stdio transport — it corrupts the JSON-RPC stream.
  process.stderr.write("invoiceninja-mcp: ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`invoiceninja-mcp fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
