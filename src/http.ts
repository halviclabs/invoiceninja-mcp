#!/usr/bin/env node
/**
 * Streamable-HTTP transport entry point — for running the server remotely
 * (e.g. on your Exoscale Zürich box) behind TLS + a reverse proxy.
 *
 * Stateless mode: each POST /mcp spins up a fresh server+transport, so the
 * process stays simple and horizontally scalable. Protect the endpoint with
 * MCP_BEARER_TOKEN and terminate TLS at your proxy (Caddy/Traefik/nginx).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const BEARER = process.env.MCP_BEARER_TOKEN?.trim();
const PATH = "/mcp";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

const httpServer = createHttpServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const url = (req.url ?? "").split("?")[0];
  if (url !== PATH) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (BEARER) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${BEARER}`) return unauthorized(res);
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Stateless: fresh server + transport per request.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    const body = await readBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Bad request" }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(
    `invoiceninja-mcp: streamable-http on http://${HOST}:${PORT}${PATH}` +
      `${BEARER ? " (bearer auth on)" : " (NO AUTH — set MCP_BEARER_TOKEN!)"}\n`,
  );
});
