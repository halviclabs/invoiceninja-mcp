/**
 * Thin, typed wrapper over the Invoice Ninja v5 REST API.
 *
 * Auth model (v5): every request carries
 *   X-API-TOKEN:       <company token>
 *   X-Requested-With:  XMLHttpRequest   (required, else IN returns HTML/redirects)
 *   X-Api-Secret:      <optional secret>
 *
 * Reference: https://api-docs.invoicing.co
 */
import type { Config } from "./config.js";

export interface ListOptions {
  perPage?: number;
  page?: number;
  /** Free-text search across the entity's searchable columns. */
  filter?: string;
  /** Comma-separated relationships to side-load, e.g. "client,invitations". */
  include?: string;
  /** Sort directive, e.g. "date|desc". */
  sort?: string;
  /** Arbitrary extra query params (status flags, overdue, payable, client_id, ...). */
  extra?: Record<string, string | number | boolean | undefined>;
}

export class InvoiceNinjaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "InvoiceNinjaError";
  }
}

export class InvoiceNinjaClient {
  private readonly api: string;

  constructor(private readonly cfg: Config) {
    this.api = `${cfg.baseUrl}/api/v1`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "X-API-TOKEN": this.cfg.token,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.cfg.secret) h["X-Api-Secret"] = this.cfg.secret;
    return h;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.api + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      throw new InvoiceNinjaError(`Network error calling ${method} ${path}: ${reason}`, 0, null);
    }
    clearTimeout(timer);

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* leave as raw text — usually an HTML error page from a misrouted request */
    }

    if (!res.ok) {
      const msg =
        (parsed as { message?: string })?.message ||
        `Invoice Ninja API ${res.status} on ${method} ${path}`;
      throw new InvoiceNinjaError(msg, res.status, parsed);
    }
    return parsed as T;
  }

  // ---- Generic CRUD over any entity collection -----------------------------

  list<T = unknown>(entity: string, opts: ListOptions = {}): Promise<{ data: T[]; meta?: unknown }> {
    const perPage = Math.min(opts.perPage ?? 20, this.cfg.maxPerPage);
    return this.request("GET", `/${entity}`, {
      query: {
        per_page: perPage,
        page: opts.page,
        filter: opts.filter,
        include: opts.include,
        sort: opts.sort,
        ...opts.extra,
      },
    });
  }

  get<T = unknown>(entity: string, id: string, include?: string): Promise<{ data: T }> {
    return this.request("GET", `/${entity}/${id}`, { query: { include } });
  }

  create<T = unknown>(entity: string, body: unknown): Promise<{ data: T }> {
    return this.request("POST", `/${entity}`, { body });
  }

  update<T = unknown>(entity: string, id: string, body: unknown): Promise<{ data: T }> {
    return this.request("PUT", `/${entity}/${id}`, { body });
  }

  /**
   * Per-entity action route: GET /<entity>/<id>/<action> (e.g. invoice
   * mark_sent, mark_paid, cancel). Not available for every entity — tasks
   * have no such route and must use bulk() for archive/restore/delete.
   */
  action<T = unknown>(entity: string, id: string, action: string): Promise<{ data: T }> {
    return this.request("GET", `/${entity}/${id}/${action}`);
  }

  /** Bulk action endpoint, e.g. POST /invoices/bulk { action, ids: [...] }. */
  bulk<T = unknown>(entity: string, action: string, ids: string[]): Promise<{ data: T }> {
    return this.request("POST", `/${entity}/bulk`, { body: { action, ids } });
  }

  /**
   * Attach a document to an entity via PUT /<entity>/<id>/upload (multipart,
   * Laravel method spoofing: POST + _method=PUT). Reads the file from the
   * local filesystem, so only meaningful where the server runs beside it.
   */
  async uploadDocument<T = unknown>(
    entity: string,
    id: string,
    filePath: string,
    fileName?: string,
  ): Promise<{ data: T }> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append("_method", "PUT");
    form.append("documents[]", new Blob([new Uint8Array(buf)]), fileName ?? basename(filePath));
    const url = new URL(`${this.api}/${entity}/${id}/upload`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-TOKEN": this.cfg.token,
        "X-Requested-With": "XMLHttpRequest",
        ...(this.cfg.secret ? { "X-Api-Secret": this.cfg.secret } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new InvoiceNinjaError(`Upload to ${entity}/${id} failed (${res.status})`, res.status, parsed);
    }
    return parsed as { data: T };
  }

  /** Health probe — hits a cheap, always-present route. */
  async ping(): Promise<{ ok: boolean; sampleCount: number }> {
    const res = await this.list("clients", { perPage: 1 });
    return { ok: true, sampleCount: Array.isArray(res.data) ? res.data.length : 0 };
  }
}
