#!/usr/bin/env node
/**
 * Streamable-HTTP transport entry point — for running the server remotely behind TLS and a reverse proxy, or next to
 * an ALVIREQ instance (its chart sets INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS and sends each connection's
 * credentials per request). Protect the endpoint with MCP_BEARER_TOKEN; see ./httpApp.ts and ./requestCredentials.ts.
 */
import { createServer as createHttpServer } from "node:http";
import { requireRequestCredentials } from "./config.js";
import { createHandler } from "./httpApp.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const BEARER = process.env.MCP_BEARER_TOKEN?.trim();

if (requireRequestCredentials() && !BEARER) {
  process.stderr.write(
    "invoiceninja-mcp: INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS needs MCP_BEARER_TOKEN; credential headers are read only behind it.\n",
  );
  process.exit(1);
}

const httpServer = createHttpServer(createHandler({ bearer: BEARER }));
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.maxRequestsPerSocket = 100;

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(
    `invoiceninja-mcp: streamable-http on http://${HOST}:${PORT}/mcp` +
      `${BEARER ? " (bearer auth on)" : " (NO AUTH — set MCP_BEARER_TOKEN!)"}` +
      `${requireRequestCredentials() ? ", credentials per request" : ""}\n`,
  );
});
