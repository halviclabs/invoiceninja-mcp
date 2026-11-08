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
import { InputError, pathSegment } from "./security.js";

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

/** What an Invoice Ninja error body may tell the model: its message and per-field validation errors, bounded. */
export interface UpstreamDetails {
  message?: string;
  errors?: Record<string, string[]>;
}

export class InvoiceNinjaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: UpstreamDetails,
  ) {
    super(message);
    this.name = "InvoiceNinjaError";
  }
}

const DETAIL_CHARS = 300;
const DETAIL_FIELDS = 20;
const DETAIL_PER_FIELD = 5;

/**
 * Extract the allowlisted parts of an Invoice Ninja error body (Laravel's {message, errors: {field: [..]}}). Only
 * strings, bounded in number and length; anything else in the body is dropped.
 */
export function upstreamDetails(buf: Buffer): UpstreamDetails | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(buf.toString("utf8")); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const body = parsed as Record<string, unknown>;
  const out: UpstreamDetails = {};
  if (typeof body.message === "string" && body.message) out.message = body.message.slice(0, DETAIL_CHARS);
  if (body.errors && typeof body.errors === "object" && !Array.isArray(body.errors)) {
    const errors: Record<string, string[]> = {};
    for (const [field, value] of Object.entries(body.errors).slice(0, DETAIL_FIELDS)) {
      const list = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
      if (list.length && /^[\w.\-\[\]]{1,128}$/.test(field)) errors[field] = list.slice(0, DETAIL_PER_FIELD).map((v) => v.slice(0, DETAIL_CHARS));
    }
    if (Object.keys(errors).length) out.errors = errors;
  }
  return out.message || out.errors ? out : undefined;
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

  private async send<T>(url: URL, method: string, body?: string | FormData, multipart = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers = this.headers();
      if (multipart) delete headers["Content-Type"];
      const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: "error" });
      let buf: Buffer;
      try {
        buf = await this.readBounded(res, controller);
      } catch (err) {
        // An oversized error body still reports the status; the details are simply absent.
        if (!res.ok) throw new InvoiceNinjaError(`Invoice Ninja API returned HTTP ${res.status}.`, res.status);
        throw err;
      }
      if (!res.ok) {
        // 422 carries which field Invoice Ninja rejected; the model needs that to correct its input.
        throw new InvoiceNinjaError(`Invoice Ninja API returned HTTP ${res.status}.`, res.status, upstreamDetails(buf));
      }
      try {
        return (buf.length ? JSON.parse(buf.toString("utf8")) : null) as T;
      } catch {
        throw new InvoiceNinjaError("Invoice Ninja returned invalid JSON.", 0);
      }
    } catch (err) {
      if (err instanceof InvoiceNinjaError) throw err;
      // Never return an upstream body, URL, native error, or credentials to the model.
      throw new InvoiceNinjaError(controller.signal.aborted ? "Invoice Ninja request timed out." : "Invoice Ninja network request failed.", 0);
    } finally {
      clearTimeout(timer); // Includes response-body consumption, not just response headers.
    }
  }

  /** The whole body, or an InvoiceNinjaError once it exceeds maxResponseBytes (the request is aborted). */
  private async readBounded(res: Response, controller: AbortController): Promise<Buffer> {
    if (Number(res.headers.get("content-length")) > this.cfg.maxResponseBytes) {
      await res.body?.cancel();
      throw new InvoiceNinjaError("Invoice Ninja response is too large.", 0);
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.cfg.maxResponseBytes) {
            controller.abort();
            throw new InvoiceNinjaError("Invoice Ninja response is too large.", 0);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return Buffer.concat(chunks);
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

    return this.send<T>(url, method, opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  }

  // ---- Generic CRUD over any entity collection -----------------------------

  list<T = unknown>(entity: string, opts: ListOptions = {}): Promise<{ data: T[]; meta?: unknown }> {
    const perPage = Math.min(opts.perPage ?? 20, this.cfg.maxPerPage);
    return this.request("GET", `/${pathSegment(entity)}`, {
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
    return this.request("GET", `/${pathSegment(entity)}/${pathSegment(id)}`, { query: { include } });
  }

  create<T = unknown>(entity: string, body: unknown): Promise<{ data: T }> {
    return this.request("POST", `/${pathSegment(entity)}`, { body });
  }

  update<T = unknown>(entity: string, id: string, body: unknown): Promise<{ data: T }> {
    return this.request("PUT", `/${pathSegment(entity)}/${pathSegment(id)}`, { body });
  }

  /**
   * Per-entity action route: GET /<entity>/<id>/<action> (e.g. invoice
   * mark_sent, mark_paid, cancel). Not available for every entity — tasks
   * have no such route and must use bulk() for archive/restore/delete.
   */
  action<T = unknown>(entity: string, id: string, action: string): Promise<{ data: T }> {
    return this.request("GET", `/${pathSegment(entity)}/${pathSegment(id)}/${pathSegment(action)}`);
  }

  /** Bulk action endpoint, e.g. POST /invoices/bulk { action, ids: [...] }. */
  bulk<T = unknown>(entity: string, action: string, ids: string[]): Promise<{ data: T }> {
    ids.forEach(pathSegment);
    return this.request("POST", `/${pathSegment(entity)}/bulk`, { body: { action: pathSegment(action), ids } });
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
    const url = new URL(`${this.api}/${pathSegment(entity)}/${pathSegment(id)}/upload`);
    if (!this.cfg.uploadDir) throw new InputError("Local uploads require INVOICE_NINJA_UPLOAD_DIR.");
    if (fileName !== undefined && (!fileName || fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(fileName))) {
      throw new InputError("Invalid upload file name.");
    }
    const { realpath, open } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    const { basename, resolve, relative, isAbsolute, sep } = await import("node:path");
    let buf: Buffer;
    try {
      const root = await realpath(this.cfg.uploadDir);
      const target = await realpath(resolve(root, filePath));
      const inside = relative(root, target);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new InputError("File is outside the upload directory.");
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > this.cfg.maxUploadBytes) throw new InputError("Upload must be a regular file within the upload size limit.");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          bytes += chunk.length;
          if (bytes > this.cfg.maxUploadBytes) throw new InputError("Upload is too large.");
          chunks.push(chunk);
        }
        buf = Buffer.concat(chunks);
      } finally {
        await file.close();
      }
    } catch (err) {
      if (err instanceof InputError) throw err;
      throw new InputError("Unable to read a regular file from the upload directory.");
    }
    const form = new FormData();
    form.append("_method", "PUT");
    form.append("documents[]", new Blob([new Uint8Array(buf)]), fileName ?? basename(filePath));
    return this.send<{ data: T }>(url, "POST", form, true);
  }

  /** Health probe — hits a cheap, always-present route. */
  /**
   * A read-only check: one client row, then the token's company (id and name) where the instance tells. The company
   * is optional so an older Invoice Ninja without POST /companies/current still pings.
   */
  async ping(): Promise<{ ok: boolean; sampleCount: number; company?: { id: string; name: string } }> {
    const res = await this.list("clients", { perPage: 1 });
    const out: { ok: boolean; sampleCount: number; company?: { id: string; name: string } } = {
      ok: true,
      sampleCount: Array.isArray(res.data) ? res.data.length : 0,
    };
    try {
      // POST, but it only reads: Invoice Ninja returns the company the token belongs to.
      const current = await this.request<{ data?: { id?: unknown; settings?: { name?: unknown } } }>("POST", "/companies/current");
      const id = typeof current?.data?.id === "string" ? current.data.id : "";
      const name = typeof current?.data?.settings?.name === "string" ? current.data.settings.name.trim() : "";
      if (id || name) out.company = { id, name };
    } catch (err) {
      // A refused token already failed on the client list; anything else leaves the company out.
      if (err instanceof InvoiceNinjaError && (err.status === 401 || err.status === 403)) throw err;
    }
    return out;
  }
}
