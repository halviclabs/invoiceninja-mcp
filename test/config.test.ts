import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, checkRequestUrl, loadConfig } from "../src/config.js";

const ENV = { INVOICE_NINJA_URL: "https://env.example.ch/", INVOICE_NINJA_TOKEN: "env-token" };

test("environment only, as before", () => {
  const cfg = loadConfig(ENV);
  assert.equal(cfg.baseUrl, "https://env.example.ch");
  assert.equal(cfg.token, "env-token");
  assert.equal(cfg.safeMode, false);
});

test("missing environment values still fail without the request flag", () => {
  assert.throws(() => loadConfig({}), (e: unknown) => e instanceof ConfigError && e.code === "missing_credentials");
  assert.throws(() => loadConfig({ INVOICE_NINJA_URL: "https://x.ch" }), /INVOICE_NINJA_TOKEN/);
});

test("overrides win over the environment", () => {
  const cfg = loadConfig(ENV, { baseUrl: "https://a.example.ch", token: "a-token" });
  assert.equal(cfg.baseUrl, "https://a.example.ch");
  assert.equal(cfg.token, "a-token");
});

test("with the request flag the environment's address and token are not used", () => {
  const env = { ...ENV, INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "true" };
  assert.throws(() => loadConfig(env), (e: unknown) => e instanceof ConfigError && e.code === "missing_credentials");
  assert.throws(() => loadConfig(env, { token: "only-token" }), /both are required/);
  const cfg = loadConfig({ INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: "1" }, { baseUrl: "https://b.ch", token: "b" });
  assert.equal(cfg.baseUrl, "https://b.ch");
  assert.equal(cfg.token, "b");
});

test("partial request credentials never fall back to environment credentials", () => {
  for (const overrides of [{ baseUrl: "https://other.example.ch" }, { token: "only-token" }, { baseUrl: "https://other.example.ch", token: " " }]) {
    assert.throws(() => loadConfig(ENV, overrides), (e: unknown) => e instanceof ConfigError && e.code === "missing_credentials");
  }
});

test("environment API secret is only used with environment credentials", () => {
  const env = { ...ENV, INVOICE_NINJA_SECRET: "env-secret" };
  assert.equal(loadConfig(env).secret, "env-secret");
  for (const required of ["true", "false"]) {
    const cfg = loadConfig({ ...env, INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: required }, { baseUrl: "https://other.example.ch", token: "request-token" });
    assert.equal(cfg.token, "request-token");
    assert.equal(cfg.secret, undefined);
  }
});

test("safe mode: the request may switch it on; the environment's safe mode is a floor", () => {
  assert.equal(loadConfig(ENV, { safeMode: true }).safeMode, true);
  assert.equal(loadConfig(ENV, { safeMode: false }).safeMode, false);
  assert.equal(loadConfig({ ...ENV, INVOICE_NINJA_SAFE_MODE: "true" }, { safeMode: false }).safeMode, true);
  assert.equal(loadConfig({ ...ENV, INVOICE_NINJA_SAFE_MODE: "true" }).safeMode, true);
});

test("request address rules", () => {
  assert.equal(checkRequestUrl("https://invoicing.co"), "https://invoicing.co");
  assert.equal(checkRequestUrl(" https://in.example.ch/api/v1/ "), "https://in.example.ch");
  assert.equal(checkRequestUrl("https://example.ch/billing/api/v1"), "https://example.ch/billing");
  assert.equal(checkRequestUrl("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(checkRequestUrl("http://localhost:9000/"), "http://localhost:9000");
  const invalid = (raw: string) =>
    assert.throws(() => checkRequestUrl(raw), (e: unknown) => e instanceof ConfigError && e.code === "invalid_url", raw);
  invalid("http://invoicing.co");
  invalid("ftp://invoicing.co");
  invalid("https://user:pw@invoicing.co");
  invalid("https://user@invoicing.co");
  invalid("invoicing.co");
  invalid("https://invoicing.co/?a=1");
  invalid("");
});
