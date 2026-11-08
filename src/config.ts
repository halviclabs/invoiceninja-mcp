/**
 * Runtime configuration, loaded from environment variables.
 *
 * Sovereignty note: this server talks ONLY to your Invoice Ninja instance.
 * Point INVOICE_NINJA_URL at your self-hosted box (e.g. Exoscale Zürich) and
 * no data ever transits a third-party SaaS bridge.
 */

export interface Config {
  /** Base URL of the Invoice Ninja instance, WITHOUT a trailing /api/v1. */
  baseUrl: string;
  /** Company API token from Settings > Account Management > Integrations > API Tokens. */
  token: string;
  /** Optional X-Api-Secret (only relevant if api_secret is set in your .env on the IN side). */
  secret?: string;
  /** When false (default), all write/mutating tools are disabled. Opt-in only. */
  allowWrites: boolean;
  /**
   * Safe mode: writes are on, but nothing is sent or settled. Leaves out in_invoice_action, in_quote_action and
   * in_create_payment, and narrows in_task_action to archive and restore. Hosts with their own approval gate
   * (ALVIREQ) run with writes on and safe mode on, so drafts, clients, expenses and time entries work while
   * emailing, marking paid, cancelling and deleting stay in Invoice Ninja.
   */
  safeMode: boolean;
  /** Tool names that are never registered (INVOICE_NINJA_DISABLED_TOOLS, comma-separated). */
  disabledTools: Set<string>;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Hard cap on per_page to avoid dumping huge payloads into the model context. */
  maxPerPage: number;
  maxResponseBytes: number;
  uploadDir?: string;
  maxUploadBytes: number;
}

export function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Values a single request may set instead of the environment (HTTP transport only, after the bearer check; see
 * ./requestCredentials.ts). ALVIREQ sends the connection's address, token and safe-mode choice with every request.
 */
export interface ConfigOverrides {
  baseUrl?: string;
  token?: string;
  safeMode?: boolean;
}

/** A configuration the server cannot run with: missing credentials or an address it refuses. */
export class ConfigError extends Error {
  constructor(
    readonly code: "missing_credentials" | "invalid_url" | "invalid_header" | "invalid_config",
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Strip trailing slashes and an accidental /api/v1 suffix. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/+$/, "");
}

/**
 * Validate an operator-approved base URL. HTTPS is the default; HTTP requires an explicit opt-in.
 * Request-selected destinations must additionally match the exact base-URL allowlist in loadConfig.
 */
export function checkRequestUrl(raw: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("invalid_url", "The Invoice Ninja address is not a valid URL.");
  }
  if (url.username || url.password) throw new ConfigError("invalid_url", "The Invoice Ninja address must not contain a user name or password.");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ConfigError("invalid_url", "The Invoice Ninja address must use HTTPS (HTTP requires INVOICE_NINJA_ALLOW_HTTP=true).");
  }
  if (url.search || url.hash) throw new ConfigError("invalid_url", "The Invoice Ninja address must not contain a query or fragment.");
  return normalizeBaseUrl(`${url.origin}${url.pathname}`);
}

export function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConfigError("invalid_config", `${name} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

export function allowedRequestUrls(env: NodeJS.ProcessEnv): Set<string> {
  const allowHttp = bool(env.INVOICE_NINJA_ALLOW_HTTP, false);
  const urls = new Set((env.INVOICE_NINJA_ALLOWED_URLS ?? "").split(",").map(s => s.trim()).filter(Boolean).map(s => checkRequestUrl(s, allowHttp)));
  if (!urls.size) throw new ConfigError("invalid_config", "Request credentials require INVOICE_NINJA_ALLOWED_URLS (exact trusted base URLs).");
  return urls;
}

/**
 * The configuration for one server instance. Request credentials must be a complete pair and never inherit
 * the environment's token or API secret.
 *
 * With INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true the address and token come only from the request, so the
 * environment needs neither (ALVIREQ's chart runs it that way). Safe mode from the environment is a floor: a request
 * can switch safe mode on, never off when INVOICE_NINJA_SAFE_MODE=true.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): Config {
  const fromRequestOnly = requireRequestCredentials(env);
  const requestCredentials = fromRequestOnly || overrides.baseUrl !== undefined || overrides.token !== undefined;
  const rawUrl = requestCredentials ? overrides.baseUrl : env.INVOICE_NINJA_URL?.trim();
  const token = requestCredentials ? overrides.token : env.INVOICE_NINJA_TOKEN?.trim();

  if (requestCredentials && (!rawUrl?.trim() || !token?.trim())) {
    throw new ConfigError(
      "missing_credentials",
      "This server takes the Invoice Ninja address and token from each request " +
        "(X-Invoice-Ninja-Url and X-Invoice-Ninja-Token); both are required.",
    );
  }
  if (!rawUrl) {
    throw new ConfigError(
      "missing_credentials",
      "INVOICE_NINJA_URL is required (e.g. https://invoicing.example.ch). " +
        "Do NOT include /api/v1 — it is appended automatically.",
    );
  }
  if (!token) {
    throw new ConfigError(
      "missing_credentials",
      "INVOICE_NINJA_TOKEN is required. Create one under " +
        "Settings > Account Management > Integrations > API Tokens.",
    );
  }

  const envSafeMode = bool(env.INVOICE_NINJA_SAFE_MODE, false);
  const baseUrl = checkRequestUrl(rawUrl, bool(env.INVOICE_NINJA_ALLOW_HTTP, false));
  if (requestCredentials && !allowedRequestUrls(env).has(baseUrl)) {
    throw new ConfigError("invalid_url", "The Invoice Ninja address is not allowed by this server.");
  }
  if (token.length > 4096 || /[\r\n]/.test(token)) throw new ConfigError("invalid_config", "The Invoice Ninja token is malformed.");
  return {
    baseUrl,
    token,
    secret: requestCredentials ? undefined : env.INVOICE_NINJA_SECRET?.trim() || undefined,
    allowWrites: bool(env.INVOICE_NINJA_ALLOW_WRITES, false),
    safeMode: envSafeMode || overrides.safeMode === true,
    disabledTools: new Set(
      (env.INVOICE_NINJA_DISABLED_TOOLS ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
    timeoutMs: integer(env, "INVOICE_NINJA_TIMEOUT_MS", 30_000, 120_000),
    maxPerPage: integer(env, "INVOICE_NINJA_MAX_PER_PAGE", 100, 1_000),
    maxResponseBytes: integer(env, "INVOICE_NINJA_MAX_RESPONSE_BYTES", 2_097_152, 16_777_216),
    uploadDir: env.INVOICE_NINJA_UPLOAD_DIR?.trim() || undefined,
    maxUploadBytes: integer(env, "INVOICE_NINJA_MAX_UPLOAD_BYTES", 10_485_760, 20_971_520),
  };
}

/** INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS: every request must carry the address and token itself. */
export const requireRequestCredentials = (env: NodeJS.ProcessEnv = process.env) =>
  bool(env.INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS, false);
