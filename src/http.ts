#!/usr/bin/env node
/**
 * Streamable-HTTP transport entry point — for running the server remotely behind TLS and a reverse proxy, or next to
 * an ALVIREQ instance (its chart sets INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS and sends each connection's
 * credentials per request). MCP_BEARER_TOKEN is mandatory; see ./httpApp.ts and ./requestCredentials.ts.
 */
import { createServer as createHttpServer } from "node:http";
import { ConfigError, requireRequestCredentials } from "./config.js";
import { createHandler } from "./httpApp.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

let handler: ReturnType<typeof createHandler>;
try {
  handler = createHandler({ bearer: process.env.MCP_BEARER_TOKEN });
} catch (err) {
  // A configuration problem is an operator message, not a stack trace.
  process.stderr.write(`invoiceninja-mcp: ${err instanceof ConfigError ? err.message : "invalid configuration"}\n`);
  process.exit(1);
}

const httpServer = createHttpServer(handler);
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.maxRequestsPerSocket = 100;

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(
    `invoiceninja-mcp: streamable-http on http://${HOST}:${PORT}/mcp (bearer auth on)` +
      `${requireRequestCredentials() ? ", credentials per request" : ""}\n`,
  );
});
