import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, request, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHandler } from "../src/httpApp.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { InvoiceNinjaClient, InvoiceNinjaError } from "../src/client.js";

const BEARER = "hardening-test-bearer";
const TOKEN = "operator-token-never-return";
const SECRET = "operator-secret-never-return";
const headers = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

async function fixture(t: TestContext, handler: RequestListener = (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"data":{"id":"record"}}'); }) {
  const servers: Server[] = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  async function listen(listener: RequestListener) {
    const server = httpServer(listener);
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const ninja = await listen(handler);
  const env = { INVOICE_NINJA_URL: ninja, INVOICE_NINJA_TOKEN: TOKEN, INVOICE_NINJA_SECRET: SECRET, INVOICE_NINJA_ALLOW_HTTP: "true" };
  return {
    ninja, env, listen,
    endpoint: (extra: NodeJS.ProcessEnv = {}) => listen(createHandler({ bearer: BEARER, env: { ...env, ...extra } })),
  };
}

async function rpc(base: string, body: unknown, extra: Record<string, string> = {}) {
  // Native fetch may replace Host; use a real raw HTTP header for Host policy tests.
  if (extra.Host) return new Promise<Response>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers: { ...headers, ...extra } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  return fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}

test("SEC-01: read-only, safe-mode and deny-list tools cannot reach action paths", async t => {
  let seen = 0;
  const f = await fixture(t, (_req, res) => { seen++; res.end('{"data":{}}'); });
  const malicious = ["record/mark_paid", "../invoices/record/delete", "%2e%2e%2finvoices", "..", ".", "record?x=1", "record#x", "record\\delete", ""];
  for (const extra of [{}, { INVOICE_NINJA_ALLOW_WRITES: "true", INVOICE_NINJA_SAFE_MODE: "true", INVOICE_NINJA_DISABLED_TOOLS: "in_invoice_action" }]) {
    const base = await f.endpoint(extra);
    for (const id of malicious) {
      const response = await rpc(base, call("in_get_invoice", { id }));
      assert.match(await response.text(), /Invalid record identifier/);
    }
  }
  const client = new InvoiceNinjaClient(loadConfig(f.env));
  assert.throws(() => client.update("clients", "record/delete", {}), /identifier/);
  assert.throws(() => client.action("invoices", "../record", "delete"), /identifier/);
  assert.throws(() => client.bulk("tasks", "delete", ["record/other"]), /identifier/);
  assert.equal(seen, 0);
});

test("SEC-02: HTTP rejects oversized, batched, deep, long-string and oversized-array inputs", async t => {
  const f = await fixture(t);
  const base = await f.endpoint();
  assert.equal((await rpc(base, { ...ping, params: { value: "x".repeat(270000) } })).status, 413);
  for (const batch of [[ping], Array(150).fill(ping)]) assert.equal((await rpc(base, batch)).status, 400);
  let deep: unknown = 0;
  for (let i = 0; i < 25; i++) deep = { nested: deep };
  for (const value of [deep, "x".repeat(17000), Array(1001).fill(null)]) {
    assert.equal((await rpc(base, { ...ping, params: { value } })).status, 400);
  }
  assert.equal((await rpc(base, { ...ping, params: { value: Array.from({ length: 20 }, () => Array(1000).fill(0)) } })).status, 400);
  const writes = await f.endpoint({ INVOICE_NINJA_ALLOW_WRITES: "true" });
  const invalid = await rpc(writes, call("in_create_invoice", { client_id: "record", line_items: Array(1000).fill(null) }));
  assert.ok((await invalid.text()).length < 8192);
  // Chunked encoding cannot evade the byte counter with an absent Content-Length.
  const chunked = await new Promise<number>(resolve => {
    const req = request(`${base}/mcp`, { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", () => {});
    req.write("x".repeat(270000));
    req.end();
  });
  assert.equal(chunked, 413);
});

test("SEC-02: rate and concurrent-call limits apply across stateless servers", async t => {
  let release: (() => void) | undefined;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, (_req, res) => { release = () => res.end('{"data":{}}'); started(); });
  const base = await f.endpoint({ MCP_MAX_CONCURRENT_REQUESTS: "1" });
  const first = rpc(base, call("in_get_client", { id: "record" }));
  await entered;
  assert.equal((await rpc(base, ping)).status, 429);
  release!();
  await (await first).text();
  const rate = await f.endpoint({ MCP_RATE_LIMIT_PER_MINUTE: "2" });
  for (let i = 0; i < 2; i++) assert.equal((await rpc(rate, ping)).status, 200);
  assert.equal((await rpc(rate, ping)).status, 429);
});

test("SEC-02: a stalled request body releases its concurrency slot on timeout", async t => {
  const f = await fixture(t);
  const base = await f.endpoint({ MCP_BODY_TIMEOUT_MS: "50", MCP_MAX_CONCURRENT_REQUESTS: "1" });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers }, res => { res.resume(); resolve(res.statusCode!); req.destroy(); });
    req.on("error", reject);
    req.write('{"unfinished":');
  });
  assert.equal(status, 408);
  assert.equal((await rpc(base, ping)).status, 200);
});

test("SEC-03: request mode needs exact trusted URLs and HTTP requires explicit opt-in", async t => {
  let seen = 0;
  const f = await fixture(t, (_req, res) => { seen++; res.end('{"data":{}}'); });
  assert.throws(() => createHandler({ bearer: BEARER, env: { INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" } }), /ALLOWED_URLS/);
  const base = await f.endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true", INVOICE_NINJA_ALLOWED_URLS: "https://trusted.example/ninja" });
  for (const url of [f.ninja, "https://127.0.0.1", "https://trusted.example:8443/ninja", "https://trusted.example/other", "https://trusted.example.evil/ninja"]) {
    const response = await rpc(base, call("in_ping", {}), { "X-Invoice-Ninja-Url": url, "X-Invoice-Ninja-Token": "caller-token" });
    assert.equal(response.status, 400);
  }
  assert.throws(() => loadConfig({ ...f.env, INVOICE_NINJA_ALLOW_HTTP: undefined }), /HTTPS/);
  assert.equal(seen, 0);
});

test("SEC-04: HTTP fails closed and rejects foreign Host, Origin and duplicate security headers", async t => {
  const f = await fixture(t);
  for (const bearer of [undefined, "", " "]) assert.throws(() => createHandler({ bearer, env: f.env }), /MCP_BEARER_TOKEN/);
  const base = await f.endpoint();
  const foreign: Record<string, string>[] = [{ Host: "foreign.example" }, { Origin: "https://foreign.example" }];
  for (const extra of foreign) assert.equal((await rpc(base, ping, extra)).status, 403);
  assert.equal((await rpc(base, ping, { Authorization: "Bearer wrong" })).status, 401);
  const configured = await f.endpoint({ MCP_ALLOWED_HOSTS: "mcp.example", MCP_ALLOWED_ORIGINS: "https://host.example" });
  assert.equal((await rpc(configured, ping, { Host: "mcp.example", Origin: "https://host.example" })).status, 200);
  const requestMode = await f.endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true", INVOICE_NINJA_ALLOWED_URLS: f.ninja });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${requestMode}/mcp`, { method: "POST", headers: [
      "Host", new URL(requestMode).host, "Authorization", `Bearer ${BEARER}`, "Content-Type", "application/json", "Accept", headers.Accept,
      "X-Invoice-Ninja-Url", f.ninja, "X-Invoice-Ninja-Token", "first", "X-Invoice-Ninja-Token", "second",
    ] }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end(JSON.stringify(ping));
  });
  assert.equal(status, 400);
});

test("SEC-05: redirects do not forward tokens, secrets or POST bodies", async t => {
  const f = await fixture(t);
  let received = 0;
  const receiver = await f.listen((_req, res) => { received++; res.end('{"data":{}}'); });
  const redirect = await f.listen((_req, res) => { res.writeHead(307, { Location: `${receiver}/capture` }); res.end(); });
  const base = await f.endpoint({ INVOICE_NINJA_URL: redirect, INVOICE_NINJA_ALLOW_WRITES: "true" });
  for (const body of [call("in_get_client", { id: "record" }), call("in_create_client", { name: "private client" })]) {
    const text = await (await rpc(base, body)).text();
    assert.match(text, /network request failed/);
    assert.ok(!text.includes(TOKEN) && !text.includes(SECRET));
  }
  assert.equal(received, 0);
});

test("SEC-06: timeout covers a delayed body and both declared and streamed response sizes are capped", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url?.includes("slow")) {
      res.writeHead(200); res.flushHeaders(); res.write('{"data":');
      const timer = setTimeout(() => res.end('{}}'), 500);
      res.on("close", () => clearTimeout(timer));
    } else if (req.url?.includes("gzip")) {
      const compressed = gzipSync(JSON.stringify({ data: { value: "x".repeat(10000) } }));
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": compressed.length });
      res.end(compressed);
    } else {
      if (req.url?.includes("declared")) res.setHeader("Content-Length", "10000");
      res.writeHead(200); res.write("x".repeat(1000)); res.end();
    }
  });
  const base = await f.endpoint({ INVOICE_NINJA_TIMEOUT_MS: "50", INVOICE_NINJA_MAX_RESPONSE_BYTES: "256" });
  assert.match(await (await rpc(base, call("in_get_client", { id: "slow" }))).text(), /timed out/);
  for (const id of ["declared", "streamed", "gzip"]) assert.match(await (await rpc(base, call("in_get_client", { id }))).text(), /too large/);
});

test("SEC-07: upstream errors and invalid JSON never expose bodies, secrets or parser details", async t => {
  const f = await fixture(t, (req, res) => {
    res.statusCode = req.url?.includes("invalid") ? 200 : 500;
    res.end(`${TOKEN} ${SECRET} internal-stack-trace ${JSON.stringify(req.headers)}`);
  });
  const base = await f.endpoint();
  for (const id of ["error", "invalid"]) {
    const text = await (await rpc(base, call("in_get_client", { id }))).text();
    for (const secret of [TOKEN, SECRET, "internal-stack-trace", "requestHeaders"]) assert.ok(!text.includes(secret));
    assert.match(text, /HTTP 500|invalid JSON/);
  }
});

test("local uploads require a staging directory and reject escapes, symlinks and oversized files", async t => {
  let received = 0;
  const f = await fixture(t, async (req, res) => { for await (const _chunk of req) { /* drain */ } received++; res.end('{"data":{"documents":[]}}'); });
  const root = await mkdtemp(join(tmpdir(), "in-upload-hardening-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, "staging");
  await mkdir(staging);
  await writeFile(join(root, "outside.txt"), "private");
  await writeFile(join(staging, "good.txt"), "receipt");
  await writeFile(join(staging, "large.txt"), "x".repeat(1000));
  await symlink(join(root, "outside.txt"), join(staging, "link.txt"));
  const cfg = loadConfig({ ...f.env, INVOICE_NINJA_UPLOAD_DIR: staging, INVOICE_NINJA_MAX_UPLOAD_BYTES: "64" });
  const client = new InvoiceNinjaClient(cfg);
  for (const path of ["../outside.txt", join(root, "outside.txt"), "link.txt", "large.txt", "."]) {
    await assert.rejects(() => client.uploadDocument("invoices", "record", path));
  }
  assert.equal(received, 0);
  await assert.rejects(() => client.uploadDocument("invoices", "record", "good.txt", "../bad-name"));
  await client.uploadDocument("invoices", "record", "good.txt");
  assert.equal(received, 1);
  const server = createServer({}, { ...f.env, INVOICE_NINJA_ALLOW_WRITES: "true" });
  const mcp = new Client({ name: "hardening", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await mcp.connect(a);
    assert.ok(!(await mcp.listTools()).tools.some(tool => tool.name === "in_upload_document"));
  } finally { await mcp.close(); await server.close(); }
});

test("numeric configuration rejects disabled, nonfinite and excessive limits", () => {
  const env = { INVOICE_NINJA_URL: "https://ninja.example", INVOICE_NINJA_TOKEN: TOKEN };
  for (const name of ["INVOICE_NINJA_TIMEOUT_MS", "INVOICE_NINJA_MAX_PER_PAGE", "INVOICE_NINJA_MAX_RESPONSE_BYTES", "INVOICE_NINJA_MAX_UPLOAD_BYTES"]) {
    for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "99999999999"]) assert.throws(() => loadConfig({ ...env, [name]: value }));
  }
});

test("REV-01: /healthz answers before the Host policy (kubelet probes use the pod IP as Host)", async t => {
  const { endpoint } = await fixture(t);
  const base = await endpoint();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/healthz`, { method: "GET", headers: { Host: "10.42.0.17:8787" } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 200);
  // The policy still applies to the MCP endpoint itself.
  assert.equal((await rpc(base, ping, { Host: "10.42.0.17:8787" })).status, 403);
});

test("REV-02: upstream validation details reach the model, bounded and allowlisted", async t => {
  const { env } = await fixture(t, (_req, res) => {
    res.statusCode = 422;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      message: "The given data was invalid.",
      errors: { name: ["The name field is required."], "contacts.0.email": ["Must be a valid email.", 42] },
      debug: { token: TOKEN, trace: "never-returned" },
    }));
  });
  const client = new InvoiceNinjaClient(loadConfig(env));
  await assert.rejects(client.create("clients", {}), (err: unknown) => {
    assert.ok(err instanceof InvoiceNinjaError);
    assert.equal(err.status, 422);
    assert.deepEqual(err.details, {
      message: "The given data was invalid.",
      errors: { name: ["The name field is required."], "contacts.0.email": ["Must be a valid email."] },
    });
    assert.ok(!JSON.stringify(err).includes(TOKEN));
    return true;
  });
});

test("REV-03: an empty numeric variable means unset, invalid values still fail closed", async t => {
  const { env } = await fixture(t);
  assert.equal(loadConfig({ ...env, INVOICE_NINJA_MAX_PER_PAGE: "" }).maxPerPage, 100);
  assert.equal(loadConfig({ ...env, INVOICE_NINJA_TIMEOUT_MS: "  " }).timeoutMs, 30_000);
  assert.throws(() => loadConfig({ ...env, INVOICE_NINJA_MAX_PER_PAGE: "0" }), /positive integer/);
  assert.throws(() => loadConfig({ ...env, INVOICE_NINJA_MAX_PER_PAGE: "abc" }), /positive integer/);
});

test("REV-04: JSON-RPC errors keep their code and message", async t => {
  const { endpoint } = await fixture(t);
  const base = await endpoint();
  const body = await (await rpc(base, { jsonrpc: "2.0", id: 7, method: "no/such-method" })).json() as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32601);
  assert.notEqual(body.error?.message, "Invalid MCP request.");
  assert.ok((body.error?.message.length ?? 0) <= 512);
});

test("REV-05: the rate limit is per token when credentials come with the request", async t => {
  const { ninja, endpoint } = await fixture(t);
  const base = await endpoint({
    INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true",
    INVOICE_NINJA_ALLOWED_URLS: ninja,
    MCP_RATE_LIMIT_PER_MINUTE: "2",
  });
  const as = (token: string) => rpc(base, ping, { "X-Invoice-Ninja-Url": ninja, "X-Invoice-Ninja-Token": token });
  assert.notEqual((await as("tenant-a")).status, 429);
  assert.notEqual((await as("tenant-a")).status, 429);
  assert.equal((await as("tenant-a")).status, 429, "third request of the same token in the window");
  assert.notEqual((await as("tenant-b")).status, 429, "another token has its own budget");
});
