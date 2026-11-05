/**
 * The streamable-HTTP request handler, separate from ./http.ts so tests can run it on a port of their own.
 *
 * Stateless mode: each POST /mcp builds a fresh server and transport from the environment plus the request's
 * credential headers (./requestCredentials.ts), so one process serves any number of Invoice Ninja accounts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, requireRequestCredentials, type ConfigOverrides } from "./config.js";
import { credentialsFrom } from "./requestCredentials.js";
import { createServer } from "./server.js";

export interface HttpOptions {
  /** MCP_BEARER_TOKEN; required for request credentials. */
  bearer?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}

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

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function createHandler(opts: HttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = opts.env ?? process.env;
  const bearer = opts.bearer?.trim() || undefined;
  const path = opts.path ?? "/mcp";
  const fromRequestOnly = requireRequestCredentials(env);
  if (fromRequestOnly && !bearer) {
    throw new ConfigError("missing_credentials", "INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS needs MCP_BEARER_TOKEN.");
  }

  return async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { status: "ok" });

    const url = (req.url ?? "").split("?")[0];
    if (url !== path) return json(res, 404, { error: "Not found" });

    if (bearer && (req.headers.authorization ?? "") !== `Bearer ${bearer}`) return json(res, 401, { error: "Unauthorized" });

    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" }, { Allow: "POST" });

    // Request credentials require explicit opt-in as well as bearer authentication.
    let overrides: ConfigOverrides = {};
    let server: ReturnType<typeof createServer>;
    try {
      if (fromRequestOnly) overrides = credentialsFrom(req.headers);
      server = createServer(overrides, env, "http");
    } catch (err) {
      if (err instanceof ConfigError) return json(res, 400, { error: err.code, message: err.message });
      return json(res, 500, { error: "server_error" });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      const body = await readBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  };
}
