// Smoke test for a running invoiceninja-mcp HTTP container: waits for /healthz, then speaks MCP over
// streamable HTTP (initialize, tools/list) and checks that the read tools are advertised.
//
//   node --input-type=module - <base-url> --bearer <token> [--wait <seconds>] < scripts/ci/mcp-smoke.mjs
//
// Dummy Invoice Ninja credentials are fine: neither call reaches Invoice Ninja. Runs with only Node's
// globals so it can be piped into a bare node:*-alpine container on the server's network.

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const bearer = opt("bearer", "");
const waitSeconds = Number(opt("wait", "60"));

if (!base) fail("usage: mcp-smoke.mjs <base-url> --bearer <token> [--wait <seconds>]");

const origin = new URL(base).origin;
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
};

function fail(message) {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
}

async function waitForHealth() {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`/healthz not ready after ${waitSeconds}s (${lastError})`);
}

/** One JSON-RPC call; the stateless transport answers as JSON or as a single SSE event. */
async function rpc(method, params = {}, id = 1) {
  const res = await fetch(`${base}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const type = res.headers.get("content-type") ?? "";
  let payload = text;
  if (type.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    payload = data.find((d) => d.includes(`"id":${id}`)) ?? data.at(-1) ?? "";
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    fail(`${method}: response is not JSON (${type}): ${text.slice(0, 200)}`);
  }
  if (parsed.error) fail(`${method}: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

await waitForHealth();
console.log("smoke: /healthz ok");

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "0" },
});
if (!init?.serverInfo?.name) fail(`initialize: no serverInfo in ${JSON.stringify(init).slice(0, 200)}`);
console.log(`smoke: initialize ok (${init.serverInfo.name} ${init.serverInfo.version ?? ""})`);

const listed = await rpc("tools/list", {}, 2);
const names = (listed?.tools ?? []).map((t) => t.name);
if (!names.includes("in_ping")) fail(`tools/list: in_ping missing from [${names.join(", ")}]`);
if (names.includes("in_upload_document")) fail("tools/list: in_upload_document must not exist on HTTP");
console.log(`smoke: tools/list ok (${names.length} tools)`);
console.log("smoke: PASS");
