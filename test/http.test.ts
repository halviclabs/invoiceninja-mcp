import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHandler } from "../src/httpApp.js";

const BEARER = "test-bearer";
const COMPANIES: Record<string, { id: string; name: string }> = {
  "token-a": { id: "aaa", name: "Company A" },
  "token-b": { id: "bbb", name: "Company B" },
  "token-env": { id: "eee", name: "Env Company" },
};

/** A fake Invoice Ninja: the clients list and the current company, per token; anything else 404. */
let ninja: Server;
let ninjaUrl = "";
const seen: string[] = [];
const servers: Server[] = [];

before(async () => {
  ninja = createServer((req, res) => {
    const token = String(req.headers["x-api-token"] ?? "");
    seen.push(token);
    const company = COMPANIES[token];
    res.setHeader("Content-Type", "application/json");
    if (!company) return res.writeHead(401).end(JSON.stringify({ message: "Invalid token" }));
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/api/v1/clients") return res.end(JSON.stringify({ data: [] }));
    if (req.method === "POST" && path === "/api/v1/companies/current") return res.end(JSON.stringify({ data: { id: company.id, settings: { name: company.name } } }));
    res.writeHead(404).end(JSON.stringify({ message: "not here" }));
  });
  await new Promise<void>((r) => ninja.listen(0, "127.0.0.1", r));
  ninjaUrl = `http://127.0.0.1:${(ninja.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of [...servers, ninja]) await new Promise<void>((r) => s.close(() => r()));
});

async function mcpServer(opts: { bearer?: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const s = createServer(createHandler({ bearer: opts.bearer, env: { INVOICE_NINJA_ALLOW_HTTP: "true", INVOICE_NINJA_ALLOWED_URLS: ninjaUrl, ...opts.env } }));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
}

async function connect(endpoint: string, headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers } }));
  return client;
}

const pingText = async (client: Client) => {
  const r = (await client.callTool({ name: "in_ping", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
};

const REQUIRED = { INVOICE_NINJA_ALLOW_WRITES: "true", INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" };
const creds = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${BEARER}`,
  "X-Invoice-Ninja-Url": ninjaUrl,
  "X-Invoice-Ninja-Token": token,
  ...extra,
});

test("each request uses its own credentials", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: REQUIRED });
  const a = await connect(endpoint, creds("token-a"));
  const b = await connect(endpoint, creds("token-b"));
  const pa = JSON.parse((await pingText(a)).text);
  const pb = JSON.parse((await pingText(b)).text);
  assert.deepEqual(pa.company, { id: "aaa", name: "Company A" });
  assert.deepEqual(pb.company, { id: "bbb", name: "Company B" });
  assert.equal(pa.instance, ninjaUrl);
  await a.close();
  await b.close();
});

test("without headers the environment is used", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: { INVOICE_NINJA_URL: ninjaUrl, INVOICE_NINJA_TOKEN: "token-env" } });
  const c = await connect(endpoint, { Authorization: `Bearer ${BEARER}` });
  assert.equal(JSON.parse((await pingText(c)).text).company.name, "Env Company");
  await c.close();
});

test("with the request flag a request without credentials is refused", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: REQUIRED });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, "missing_credentials");
});

test("a refused address is answered before anything is called", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: REQUIRED });
  const before = seen.length;
  for (const bad of ["http://invoicing.co", "https://user:pw@invoicing.co", "not a url"]) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...creds("token-a"), "X-Invoice-Ninja-Url": bad, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400, bad);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_url", bad);
  }
  assert.equal(seen.length, before);
});

test("credential headers without the bearer are refused", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: REQUIRED });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { ...creds("token-a"), Authorization: "Bearer wrong", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
});

test("HTTP refuses to start without a bearer", () => {
  assert.throws(() => createHandler({ env: {} }), /needs MCP_BEARER_TOKEN/);
});

test("the safe-mode header follows the connection's choice; the environment's safe mode is a floor", async () => {
  const names = async (env: NodeJS.ProcessEnv, safe: string) => {
    const endpoint = await mcpServer({ bearer: BEARER, env });
    const c = await connect(endpoint, creds("token-a", { "X-Invoice-Ninja-Safe-Mode": safe }));
    const list = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    return list;
  };
  const safe = await names(REQUIRED, "true");
  assert.ok(!safe.includes("in_invoice_action") && !safe.includes("in_create_payment"));
  assert.ok(safe.includes("in_create_invoice"));
  const full = await names(REQUIRED, "false");
  assert.ok(full.includes("in_invoice_action") && full.includes("in_create_payment"));
  const garbled = await names(REQUIRED, "maybe");
  assert.ok(!garbled.includes("in_invoice_action"));
  const floor = await names({ ...REQUIRED, INVOICE_NINJA_SAFE_MODE: "true" }, "false");
  assert.ok(!floor.includes("in_invoice_action"));
});

test("a refused token reaches the result without the token, and nothing is logged", async () => {
  const endpoint = await mcpServer({ bearer: BEARER, env: REQUIRED });
  const secret = "token-nobody-knows-1234";
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const c = await connect(endpoint, creds(secret));
    const r = await pingText(c);
    await c.close();
    assert.equal(r.isError, true);
    assert.match(r.text, /401/);
    assert.ok(!r.text.includes(secret));
  } finally {
    process.stderr.write = write;
  }
  assert.ok(!logged.join("").includes(secret));
});
