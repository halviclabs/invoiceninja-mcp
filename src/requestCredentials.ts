/**
 * Credentials a request carries (HTTP transport only). A host that serves several Invoice Ninja accounts through one
 * server (ALVIREQ: a company token and people's own tokens) sends each request's address, token and safe-mode choice
 * in these headers, next to the server's bearer:
 *
 *   X-Invoice-Ninja-Url        the instance's base URL (https, or http on a loopback host)
 *   X-Invoice-Ninja-Token      the API token
 *   X-Invoice-Ninja-Safe-Mode  "false" to allow sending and settling; anything else keeps safe mode on
 *
 * They are read only with INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true and after the bearer check passed.
 * The URL and token are required together; environment credentials are never attached. Values are never logged.
 */
import type { IncomingHttpHeaders } from "node:http";
import { ConfigError, checkRequestUrl, type ConfigOverrides } from "./config.js";

export const URL_HEADER = "x-invoice-ninja-url";
export const TOKEN_HEADER = "x-invoice-ninja-token";
export const SAFE_MODE_HEADER = "x-invoice-ninja-safe-mode";

const MAX_TOKEN = 4096;
const FALSE = new Set(["0", "false", "no", "off"]);

/** One header value; a repeated header is refused rather than guessed. */
function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) throw new ConfigError("invalid_header", `The header ${name} must be sent once.`);
  const t = typeof v === "string" ? v.trim() : "";
  return t || undefined;
}

/** The overrides a request asks for. Throws ConfigError for an address the server refuses or a malformed header. */
export function credentialsFrom(headers: IncomingHttpHeaders): ConfigOverrides {
  const out: ConfigOverrides = {};
  const url = single(headers, URL_HEADER);
  if (url) out.baseUrl = checkRequestUrl(url);
  const token = single(headers, TOKEN_HEADER);
  if (token) {
    if (token.length > MAX_TOKEN || /[\r\n]/.test(token)) throw new ConfigError("invalid_header", "The Invoice Ninja token header is malformed.");
    out.token = token;
  }
  const safe = single(headers, SAFE_MODE_HEADER);
  // Fail safe: only an explicit "false" switches safe mode off.
  if (safe !== undefined) out.safeMode = !FALSE.has(safe.toLowerCase());
  return out;
}
