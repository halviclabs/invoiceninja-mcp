/** Stateless HTTP with authentication and limits applied before SDK parsing or tool registration. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { allowedRequestUrls, ConfigError, integer, loadConfig, requireRequestCredentials } from "./config.js";
import { credentialsFrom } from "./requestCredentials.js";
import { createServer } from "./server.js";
import { checkInput, InputError } from "./security.js";

export interface HttpOptions {
  bearer?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(status >= 400 ? { Connection: "close" } : {}) });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", failed);
      req.off("aborted", aborted);
      if (error) {
        // Closing an oversized/aborted request may emit a later socket error.
        req.on("error", () => {});
        req.pause();
        reject(error);
      }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new HttpError(413, "Request body is too large."));
      chunks.push(chunk);
    };
    const failed = () => finish(new HttpError(400, "Request could not be read."));
    const aborted = () => finish(new HttpError(400, "Request was aborted."));
    const end = () => {
      finish();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Invalid JSON body.")); }
    };
    const timer = setTimeout(() => finish(new HttpError(408, "Request body timed out.")), timeoutMs);
    timer.unref();
    if (Number(req.headers["content-length"]) > maxBytes) return finish(new HttpError(413, "Request body is too large."));
    req.on("data", data).once("end", end).once("error", failed).once("aborted", aborted);
  });
}

export function createHandler(opts: HttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = opts.env ?? process.env;
  const bearer = opts.bearer?.trim();
  if (!bearer || bearer.length > 4096 || /[\r\n]/.test(bearer)) {
    throw new ConfigError("missing_credentials", "HTTP needs MCP_BEARER_TOKEN (nonempty, at most 4096 characters).");
  }
  const expectedAuth = Buffer.from(`Bearer ${bearer}`);
  const fromRequestOnly = requireRequestCredentials(env);
  if (fromRequestOnly) allowedRequestUrls(env);
  else loadConfig(env);
  const path = opts.path ?? "/mcp";
  const maxBytes = integer(env, "MCP_MAX_REQUEST_BYTES", 262_144, 1_048_576);
  const bodyTimeout = integer(env, "MCP_BODY_TIMEOUT_MS", 10_000, 30_000);
  const maxConcurrent = integer(env, "MCP_MAX_CONCURRENT_REQUESTS", 16, 64);
  const rate = integer(env, "MCP_RATE_LIMIT_PER_MINUTE", 120, 10_000);
  const hosts = (env.MCP_ALLOWED_HOSTS ?? "127.0.0.1,localhost,[::1]").split(",").map(s => s.trim().toLowerCase());
  const origins = new Set((env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (hosts.some(host => !host || /[\s\/@?#*]/.test(host))) throw new ConfigError("invalid_config", "MCP_ALLOWED_HOSTS requires exact hostnames, optionally with ports.");
  for (const origin of origins) {
    try { if (new URL(origin).origin !== origin) throw new Error(); }
    catch { throw new ConfigError("invalid_config", "MCP_ALLOWED_ORIGINS requires exact origins."); }
  }
  let active = 0;
  let windowStart = Date.now();
  let used = 0;

  return async (req, res) => {
    let host: URL;
    try { host = new URL(`http://${req.headers.host ?? ""}`); }
    catch { return json(res, 403, { error: "Forbidden host." }); }
    const duplicate = ["host", "origin", "authorization"].some(name => (req.headersDistinct[name]?.length ?? 0) > 1);
    if (duplicate || host.username || host.password || host.pathname !== "/" || host.search || host.hash || !hosts.some(h => h === host.host || h === host.hostname)) {
      return json(res, 403, { error: "Forbidden host or repeated security header." });
    }
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return json(res, 403, { error: "Forbidden origin." });
    if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { status: "ok" });
    if ((req.url ?? "").split("?")[0] !== path) return json(res, 404, { error: "Not found." });
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) return json(res, 401, { error: "Unauthorized." });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "JSON required." });
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); used = 0; }
    if (++used > rate || active >= maxConcurrent) return json(res, 429, { error: "Request limit exceeded." });
    active++;
    let server: ReturnType<typeof createServer> | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const body = await readBody(req, maxBytes, bodyTimeout);
      if (Array.isArray(body)) throw new HttpError(400, "JSON-RPC batches are not supported.");
      checkInput(body);
      const overrides = fromRequestOnly ? credentialsFrom(req.headers, req.headersDistinct) : {};
      server = createServer(overrides, env, "http");
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBytes });
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if ("error" in message) message = { ...message, error: { code: message.error.code, message: "Invalid MCP request." } };
        if ("result" in message && message.result.isError && JSON.stringify(message.result).length > 4096) {
          message = { ...message, result: { isError: true, content: [{ type: "text", text: "Tool input is invalid." }] } };
        }
        return send(message, options);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        if (err instanceof ConfigError) json(res, 400, { error: err.code, message: err.message });
        else if (err instanceof HttpError) json(res, err.status, { error: err.message });
        else if (err instanceof InputError) json(res, 400, { error: err.message });
        else json(res, 400, { error: "Request failed." });
      }
    } finally {
      await Promise.allSettled([transport?.close(), server?.close()]);
      active--;
    }
  };
}
