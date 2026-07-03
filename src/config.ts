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
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Hard cap on per_page to avoid dumping huge payloads into the model context. */
  maxPerPage: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.INVOICE_NINJA_URL?.trim();
  const token = env.INVOICE_NINJA_TOKEN?.trim();

  if (!rawUrl) {
    throw new Error(
      "INVOICE_NINJA_URL is required (e.g. https://invoicing.example.ch). " +
        "Do NOT include /api/v1 — it is appended automatically.",
    );
  }
  if (!token) {
    throw new Error(
      "INVOICE_NINJA_TOKEN is required. Create one under " +
        "Settings > Account Management > Integrations > API Tokens.",
    );
  }

  // Normalise: strip trailing slashes and an accidental /api/v1 suffix.
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");

  return {
    baseUrl,
    token,
    secret: env.INVOICE_NINJA_SECRET?.trim() || undefined,
    allowWrites: bool(env.INVOICE_NINJA_ALLOW_WRITES, false),
    timeoutMs: Number(env.INVOICE_NINJA_TIMEOUT_MS ?? 30_000),
    maxPerPage: Number(env.INVOICE_NINJA_MAX_PER_PAGE ?? 100),
  };
}
