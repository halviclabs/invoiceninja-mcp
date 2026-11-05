import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHandler } from "../src/httpApp.js";
import { createServer } from "../src/server.js";

const BEARER = "security-test-bearer";
const ENV_TOKEN = "security-test-environment-token";
const ENV_SECRET = "security-test-environment-secret";

interface RpcResponse {
  error?: { message: string };
  result?: { isError?: boolean; content?: { text: string }[]; tools?: { name: string }[] };
}

test("HTTP credential isolation and local-file boundaries", async (t) => {
  const servers: Server[] = [];
  const legitimate: IncomingHttpHeaders[] = [];
  const selected: { headers: IncomingHttpHeaders; body: string }[] = [];
  const dir = await mkdtemp(join(tmpdir(), "invoiceninja-security-"));
  const file = join(dir, "sample.txt");
  const marker = "harmless-upload-regression-marker";
  await writeFile(file, marker);
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function listen(handler: RequestListener): Promise<string> {
    const server = createHttpServer(handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const legitimateUrl = await listen((req, res) => {
    legitimate.push(req.headers);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [] }));
  });
  const selectedUrl = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    selected.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: req.url?.includes("/upload") ? { documents: [] } : [] }));
  });
  const env = { INVOICE_NINJA_URL: legitimateUrl, INVOICE_NINJA_TOKEN: ENV_TOKEN, INVOICE_NINJA_SECRET: ENV_SECRET };
  const requestHeaders = { "X-Invoice-Ninja-Url": selectedUrl, "X-Invoice-Ninja-Token": "request-token" };
  async function endpoint(extra: NodeJS.ProcessEnv = {}, bearer: string | undefined = BEARER) {
    return listen(createHandler({ bearer, env: { ...env, ...extra } }));
  }
  async function rpc(base: string, headers: Record<string, string>, method: string, params: unknown = {}) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${BEARER}`, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: response.status, body: await response.json() as RpcResponse };
  }
  const ping = { name: "in_ping", arguments: {} };
  const upload = { name: "in_upload_document", arguments: { entity: "invoices", id: "test-record", file_path: file } };

  await t.test("default mode ignores URL-only and full credential headers", async () => {
    const base = await endpoint();
    const before = selected.length;
    for (const headers of [{ "X-Invoice-Ninja-Url": selectedUrl }, requestHeaders]) {
      const result = await rpc(base, headers, "tools/call", ping);
      assert.equal(result.status, 200);
      assert.ok(result.body.result && !result.body.result.isError);
      assert.equal(legitimate.at(-1)?.["x-api-token"], ENV_TOKEN);
      assert.equal(legitimate.at(-1)?.["x-api-secret"], ENV_SECRET);
    }
    assert.equal(selected.length, before);
  });

  await t.test("request mode refuses incomplete credentials without network calls", async () => {
    const base = await endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" });
    const before = [selected.length, legitimate.length];
    const incomplete: Record<string, string>[] = [{}, { "X-Invoice-Ninja-Url": selectedUrl }, { "X-Invoice-Ninja-Token": "request-token" }];
    for (const headers of incomplete) {
      assert.equal((await rpc(base, headers, "tools/call", ping)).status, 400);
    }
    assert.deepEqual([selected.length, legitimate.length], before);
  });

  await t.test("request mode never sends the environment token or API secret", async () => {
    const base = await endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" });
    const before = selected.length;
    const result = await rpc(base, requestHeaders, "tools/call", ping);
    assert.equal(result.status, 200);
    assert.ok(result.body.result && !result.body.result.isError);
    assert.ok(selected.length > before);
    for (const request of selected.slice(before)) {
      assert.equal(request.headers["x-api-token"], "request-token");
      assert.equal(request.headers["x-api-secret"], undefined);
      assert.ok(!JSON.stringify(request).includes(ENV_TOKEN));
      assert.ok(!JSON.stringify(request).includes(ENV_SECRET));
    }
  });

  await t.test("request mode requires bearer configuration and rejects a wrong bearer", async () => {
    assert.throws(() => createHandler({ env: { ...env, INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" } }), /needs MCP_BEARER_TOKEN/);
    const base = await endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" });
    const before = selected.length;
    assert.equal((await rpc(base, { ...requestHeaders, Authorization: "Bearer wrong" }, "tools/call", ping)).status, 401);
    assert.equal(selected.length, before);
  });

  await t.test("HTTP neither advertises nor executes uploads in any safety mode", async () => {
    for (const requestMode of ["false", "true"]) {
      for (const safeMode of ["false", "true"]) {
        const base = await endpoint({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: requestMode, INVOICE_NINJA_ALLOW_WRITES: "true", INVOICE_NINJA_SAFE_MODE: safeMode });
        const listed = await rpc(base, requestHeaders, "tools/list");
        assert.ok(listed.body.result?.tools?.some(tool => tool.name === "in_create_invoice"));
        assert.ok(!listed.body.result?.tools?.some(tool => tool.name === "in_upload_document"));
        const before = [selected.length, legitimate.length];
        const result = await rpc(base, requestHeaders, "tools/call", upload);
        assert.match(JSON.stringify(result.body), /Tool in_upload_document not found/);
        assert.deepEqual([selected.length, legitimate.length], before);
      }
    }
  });

  await t.test("local stdio configuration retains working uploads", async () => {
    const server = createServer({}, { ...env, INVOICE_NINJA_URL: selectedUrl, INVOICE_NINJA_ALLOW_WRITES: "true", INVOICE_NINJA_SAFE_MODE: "true" });
    const client = new Client({ name: "security-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.ok((await client.listTools()).tools.some(tool => tool.name === "in_upload_document"));
      const result = await client.callTool(upload);
      assert.ok(!result.isError);
      assert.ok(selected.at(-1)?.body.includes(marker));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
