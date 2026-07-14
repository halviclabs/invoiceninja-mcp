/**
 * Tool surface exposed to the model.
 *
 * Design:
 *  - READ tools are always registered.
 *  - WRITE tools are registered only when INVOICE_NINJA_ALLOW_WRITES is truthy,
 *    and are tagged with destructive/idempotent annotations so the host UI can
 *    prompt for confirmation.
 *  - List results are PROJECTED to a handful of meaningful fields to keep the
 *    model context lean; use the matching get_* tool for the full record.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InvoiceNinjaClient, InvoiceNinjaError, type ListOptions } from "./client.js";
import type { Config } from "./config.js";
import {
  parseTimeLog,
  serializeTimeLog,
  isRunning,
  totalSeconds,
  formatDuration,
  nowEpoch,
  type TimeEntry,
} from "./timelog.js";

type Json = Record<string, unknown>;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const e =
    err instanceof InvoiceNinjaError
      ? { error: err.message, status: err.status, details: err.body }
      : { error: err instanceof Error ? err.message : String(err) };
  return { content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }], isError: true };
}

/** Keep only the listed keys from each row (shrinks list payloads). */
function project<T extends Json>(rows: T[], keys: string[]): Partial<T>[] {
  return rows.map((r) => {
    const out: Partial<T> = {};
    for (const k of keys) if (k in r) (out as Json)[k] = r[k];
    return out;
  });
}

const CLIENT_FIELDS = ["id", "name", "number", "balance", "paid_to_date", "vat_number", "is_deleted"];
const INVOICE_FIELDS = [
  "id", "number", "client_id", "status_id", "amount", "balance",
  "date", "due_date", "po_number", "is_deleted",
];
const QUOTE_FIELDS = ["id", "number", "client_id", "status_id", "amount", "date", "valid_until"];
const PAYMENT_FIELDS = ["id", "number", "client_id", "amount", "applied", "date", "type_id"];
const PRODUCT_FIELDS = ["id", "product_key", "notes", "price", "cost", "quantity"];
const EXPENSE_FIELDS = [
  "id", "number", "vendor_id", "client_id", "amount", "date", "category_id",
  "currency_id", "transaction_reference",
];
const VENDOR_FIELDS = ["id", "name", "number", "currency_id", "is_deleted"];
const EXPCAT_FIELDS = ["id", "name", "color", "is_deleted"];
const TASK_FIELDS = [
  "id", "number", "description", "client_id", "project_id", "status_id",
  "rate", "invoice_id", "is_deleted",
];
const PROJECT_FIELDS = ["id", "number", "name", "client_id", "task_rate", "budgeted_hours", "due_date"];

/** Enrich a raw task row with decoded time-log stats for the model. */
function enrichTask(task: Record<string, unknown>): Record<string, unknown> {
  const entries = parseTimeLog(task.time_log);
  const secs = totalSeconds(entries);
  return {
    ...task,
    time_entries: entries,
    tracked_seconds: secs,
    tracked_hms: formatDuration(secs),
    running: isRunning(entries),
  };
}

// Shared zod fragments for list tools.
const listShape = {
  per_page: z.number().int().min(1).max(1000).optional().describe("Rows per page (capped server-side, default 20)."),
  page: z.number().int().min(1).optional().describe("Page number for pagination."),
  filter: z.string().optional().describe("Free-text search across the entity's searchable columns."),
  sort: z.string().optional().describe("Sort directive, e.g. 'date|desc'."),
  status: z
    .enum(["active", "archived", "deleted", "all"])
    .optional()
    .describe("Record state (default 'active'). 'all' also returns archived and deleted records."),
};

function toListOpts(a: Json, extra?: ListOptions["extra"]): ListOptions {
  const status = (a.status as string | undefined) ?? "active";
  return {
    perPage: a.per_page as number | undefined,
    page: a.page as number | undefined,
    filter: a.filter as string | undefined,
    sort: a.sort as string | undefined,
    extra: {
      ...extra,
      status: status === "all" ? "active,archived,deleted" : status,
    },
  };
}

export function registerTools(server: McpServer, cfg: Config): void {
  const client = new InvoiceNinjaClient(cfg);
  const RO = { readOnlyHint: true } as const;

  // ---------------------------------------------------------------- health
  server.registerTool(
    "in_ping",
    {
      title: "Test connection",
      description: "Verify the Invoice Ninja URL, token and reachability. Returns ok + a sample row count.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        return ok({ ...(await client.ping()), instance: cfg.baseUrl, writes_enabled: cfg.allowWrites });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------------------------------------------------------- clients
  server.registerTool(
    "in_list_clients",
    { title: "List clients", description: "List clients with optional search.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("clients", toListOpts(a));
        return ok({ count: r.data.length, clients: project(r.data, CLIENT_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_get_client",
    {
      title: "Get client",
      description: "Fetch a single client by id, including its contacts and (optionally) related records.",
      inputSchema: {
        id: z.string().describe("Client id (hashed string id, not the display number)."),
        include: z.string().optional().describe("Relationships to side-load, e.g. 'invoices,documents'."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        return ok((await client.get("clients", a.id, a.include)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --------------------------------------------------------------- invoices
  server.registerTool(
    "in_list_invoices",
    {
      title: "List invoices",
      description:
        "List invoices. Use flags to narrow: client_id, client_status (draft|sent|paid|unpaid|overdue), " +
        "overdue, payable, upcoming, number.",
      inputSchema: {
        ...listShape,
        client_id: z.string().optional().describe("Restrict to one client."),
        client_status: z.string().optional().describe("draft, sent, paid, unpaid, or overdue."),
        number: z.string().optional().describe("Exact invoice number."),
        overdue: z.boolean().optional().describe("Only invoices past their due date with a balance."),
        payable: z.boolean().optional().describe("Only invoices with a remaining balance."),
        upcoming: z.boolean().optional().describe("Only invoices with no/future due date."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        const extra = {
          client_id: a.client_id,
          client_status: a.client_status,
          number: a.number,
          overdue: a.overdue ? "true" : undefined,
          payable: a.payable ? "true" : undefined,
          upcoming: a.upcoming ? "true" : undefined,
        };
        const r = await client.list<Json>("invoices", toListOpts(a, extra));
        return ok({ count: r.data.length, invoices: project(r.data, INVOICE_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_get_invoice",
    {
      title: "Get invoice",
      description: "Fetch a full invoice by id, including line items and the client relationship.",
      inputSchema: {
        id: z.string().describe("Invoice id."),
        include: z.string().optional().describe("Defaults to 'client'. e.g. 'client,payments'."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        return ok((await client.get("invoices", a.id, a.include ?? "client")).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------------------- quotes
  server.registerTool(
    "in_list_quotes",
    { title: "List quotes", description: "List quotes with optional search.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("quotes", toListOpts(a));
        return ok({ count: r.data.length, quotes: project(r.data, QUOTE_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --------------------------------------------------------------- payments
  server.registerTool(
    "in_list_payments",
    {
      title: "List payments",
      description: "List payments with optional search/client filter.",
      inputSchema: { ...listShape, client_id: z.string().optional() },
      annotations: RO,
    },
    async (a) => {
      try {
        const r = await client.list<Json>("payments", toListOpts(a, { client_id: a.client_id }));
        return ok({ count: r.data.length, payments: project(r.data, PAYMENT_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --------------------------------------------------------------- products
  server.registerTool(
    "in_list_products",
    { title: "List products", description: "List products / catalogue items.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("products", toListOpts(a));
        return ok({ count: r.data.length, products: project(r.data, PRODUCT_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --------------------------------------------------------------- expenses
  server.registerTool(
    "in_list_expenses",
    { title: "List expenses", description: "List expenses with optional search.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("expenses", toListOpts(a));
        return ok({ count: r.data.length, expenses: project(r.data, EXPENSE_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_list_vendors",
    { title: "List vendors", description: "List vendors (expense counterparties) with optional search.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("vendors", toListOpts(a));
        return ok({ count: r.data.length, vendors: project(r.data, VENDOR_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_list_expense_categories",
    { title: "List expense categories", description: "List expense categories.", inputSchema: listShape, annotations: RO },
    async (a) => {
      try {
        const r = await client.list<Json>("expense_categories", toListOpts(a));
        return ok({ count: r.data.length, categories: project(r.data, EXPCAT_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------------ AR overview
  server.registerTool(
    "in_outstanding_summary",
    {
      title: "Accounts-receivable summary",
      description:
        "Aggregate open receivables: totals for outstanding balance and overdue balance, plus the top debtors. " +
        "Computed from payable/overdue invoice listings.",
      inputSchema: {
        top: z.number().int().min(1).max(50).optional().describe("How many top debtors to return (default 10)."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        const payable = await client.list<Json>("invoices", {
          perPage: cfg.maxPerPage,
          extra: { payable: "true", status: "active" },
        });
        const overdue = await client.list<Json>("invoices", {
          perPage: cfg.maxPerPage,
          extra: { overdue: "true", status: "active" },
        });
        const sum = (rows: Json[]) =>
          rows.reduce((acc, r) => acc + (Number(r.balance) || 0), 0);
        const byClient = new Map<string, number>();
        for (const r of payable.data) {
          const id = String(r.client_id);
          byClient.set(id, (byClient.get(id) ?? 0) + (Number(r.balance) || 0));
        }
        const top = [...byClient.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, a.top ?? 10)
          .map(([client_id, balance]) => ({ client_id, balance }));
        return ok({
          outstanding_balance: Number(sum(payable.data).toFixed(2)),
          overdue_balance: Number(sum(overdue.data).toFixed(2)),
          open_invoice_count: payable.data.length,
          overdue_invoice_count: overdue.data.length,
          top_debtors: top,
          note: "Balances limited to the first page (max_per_page). Increase INVOICE_NINJA_MAX_PER_PAGE for full coverage.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ------------------------------------------------------ tasks (time entries)
  server.registerTool(
    "in_list_tasks",
    {
      title: "List tasks (time entries)",
      description:
        "List time-tracking tasks. Filter by client_id, project_id, or client_status (invoiced|uninvoiced). " +
        "Each row includes decoded tracked time and whether it is currently running.",
      inputSchema: {
        ...listShape,
        client_id: z.string().optional(),
        project_id: z.string().optional(),
        client_status: z.string().optional().describe("'invoiced' or 'uninvoiced' (comma-separable)."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        const extra = { client_id: a.client_id, project_id: a.project_id, client_status: a.client_status };
        const r = await client.list<Json>("tasks", toListOpts(a, extra));
        const rows = project(r.data, [...TASK_FIELDS, "time_log"]).map((t) => enrichTask(t as Json));
        return ok({ count: rows.length, tasks: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_get_task",
    {
      title: "Get task",
      description: "Fetch a single task with full decoded time entries, total tracked time, and running state.",
      inputSchema: {
        id: z.string(),
        include: z.string().optional().describe("e.g. 'client,project'."),
      },
      annotations: RO,
    },
    async (a) => {
      try {
        return ok(enrichTask((await client.get<Json>("tasks", a.id, a.include)).data));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_list_projects",
    {
      title: "List projects",
      description: "List projects (groupings for tasks). Filter by client_id.",
      inputSchema: { ...listShape, client_id: z.string().optional() },
      annotations: RO,
    },
    async (a) => {
      try {
        const r = await client.list<Json>("projects", toListOpts(a, { client_id: a.client_id }));
        return ok({ count: r.data.length, projects: project(r.data, PROJECT_FIELDS) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  if (!cfg.allowWrites) {
    return; // read-only deployment — stop here.
  }

  // =======================================================================
  //  WRITE TOOLS (only when INVOICE_NINJA_ALLOW_WRITES is enabled)
  // =======================================================================
  const WRITE = { readOnlyHint: false, destructiveHint: false } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

  const contactSchema = z
    .object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    .passthrough();

  server.registerTool(
    "in_create_client",
    {
      title: "Create client",
      description:
        "Create a client. Contacts must be supplied with the client — email lives on the contact, not the client.",
      inputSchema: {
        name: z.string().describe("Company / client display name."),
        contacts: z.array(contactSchema).optional().describe("At least one contact recommended."),
        vat_number: z.string().optional(),
        id_number: z.string().optional(),
        website: z.string().optional(),
        private_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("clients", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_update_client",
    {
      title: "Update client",
      description:
        "Update a client. IMPORTANT: include the FULL contacts array (with each contact's id) — " +
        "Invoice Ninja replaces contacts wholesale on every update.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        contacts: z.array(contactSchema.extend({ id: z.string().optional() })).optional(),
        vat_number: z.string().optional(),
        private_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const { id, ...body } = a;
        return ok((await client.update("clients", id, body)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const lineItemSchema = z
    .object({
      product_key: z.string().optional().describe("Catalogue key or free text label."),
      notes: z.string().optional().describe("Line description."),
      cost: z.number().describe("Unit price."),
      quantity: z.number().default(1),
      tax_name1: z.string().optional(),
      tax_rate1: z.number().optional(),
    })
    .passthrough();

  server.registerTool(
    "in_create_invoice",
    {
      title: "Create invoice",
      description: "Create an invoice for a client. Requires client_id and at least one line item.",
      inputSchema: {
        client_id: z.string().describe("Target client id."),
        line_items: z.array(lineItemSchema).min(1).describe("Invoice line items."),
        date: z.string().optional().describe("Y-m-d invoice date."),
        due_date: z.string().optional().describe("Y-m-d due date."),
        po_number: z.string().optional(),
        public_notes: z.string().optional().describe("Visible to the client."),
        private_notes: z.string().optional().describe("Internal only."),
        terms: z.string().optional(),
        footer: z.string().optional(),
        discount: z.number().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("invoices", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_update_invoice",
    {
      title: "Update invoice",
      description:
        "Partially update an invoice (drafts and undeleted invoices only). Omitted fields keep their current " +
        "values — unlike clients/contacts, a sparse invoice update does not wipe anything. Supplying line_items " +
        "replaces the whole array. Deleted invoices must be restored before editing.",
      inputSchema: {
        id: z.string().describe("Invoice id (hashed string id, not the display number)."),
        client_id: z.string().optional(),
        line_items: z.array(lineItemSchema).min(1).optional().describe("Replaces ALL line items when provided."),
        date: z.string().optional().describe("Y-m-d invoice date."),
        due_date: z.string().optional().describe("Y-m-d due date."),
        po_number: z.string().optional(),
        public_notes: z.string().optional().describe("Visible to the client."),
        private_notes: z.string().optional().describe("Internal only."),
        terms: z.string().optional(),
        footer: z.string().optional(),
        discount: z.number().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const { id, ...body } = a;
        return ok((await client.update("invoices", id, body)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_upload_document",
    {
      title: "Attach document",
      description:
        "Attach a local file (e.g. a worklog PDF) to an entity. The file is read from the filesystem the MCP " +
        "server runs on. Attached documents appear on the record and can be shown in the client portal / " +
        "included in emails depending on company settings.",
      inputSchema: {
        entity: z
          .enum(["invoices", "quotes", "clients", "tasks", "projects", "expenses", "payments", "products"])
          .describe("Entity collection the record belongs to."),
        id: z.string().describe("Record id (hashed string id)."),
        file_path: z.string().describe("Absolute path of the file to attach."),
        file_name: z.string().optional().describe("Name to store the document under (default: basename)."),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const res = (await client.uploadDocument<Json>(a.entity, a.id, a.file_path, a.file_name)).data;
        const docs = Array.isArray(res?.documents) ? (res.documents as Json[]) : [];
        return ok({
          attached: true,
          documents: docs.map((d) => ({ id: d.id, name: d.name, size: d.size, hash: d.hash })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_invoice_action",
    {
      title: "Invoice lifecycle action",
      description:
        "Apply a lifecycle action to an invoice: mark_sent, mark_paid, archive, restore, delete, cancel, email.",
      inputSchema: {
        id: z.string(),
        action: z.enum(["mark_sent", "mark_paid", "archive", "restore", "delete", "cancel", "email"]),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      try {
        // "email" is only implemented on the bulk endpoint, not the per-invoice action route.
        if (a.action === "email") {
          const res = (await client.bulk<Json[]>("invoices", "email", [a.id])).data;
          return ok(Array.isArray(res) ? res[0] : res);
        }
        return ok((await client.action("invoices", a.id, a.action)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_payment",
    {
      title: "Record payment",
      description: "Record a payment, optionally applied to one or more invoices.",
      inputSchema: {
        client_id: z.string(),
        amount: z.number(),
        date: z.string().optional().describe("Y-m-d payment date."),
        invoices: z
          .array(z.object({ invoice_id: z.string(), amount: z.number() }))
          .optional()
          .describe("Allocations to specific invoices."),
        transaction_reference: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("payments", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_quote",
    {
      title: "Create quote",
      description: "Create a quote for a client. Requires client_id and at least one line item.",
      inputSchema: {
        client_id: z.string(),
        line_items: z.array(lineItemSchema).min(1),
        date: z.string().optional(),
        valid_until: z.string().optional(),
        public_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("quotes", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_product",
    {
      title: "Create product",
      description: "Add a catalogue product.",
      inputSchema: {
        product_key: z.string(),
        notes: z.string().optional(),
        price: z.number().optional(),
        cost: z.number().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("products", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_expense",
    {
      title: "Create expense",
      description:
        "Record an expense. currency_id sets the expense currency (defaults to the company currency); " +
        "common ids: 1=USD, 3=EUR, 17=CHF. Attach the source receipt afterwards with in_upload_document.",
      inputSchema: {
        amount: z.number().describe("Amount in the expense currency."),
        date: z.string().optional().describe("Y-m-d expense date."),
        vendor_id: z.string().optional(),
        client_id: z.string().optional(),
        project_id: z.string().optional().describe("Assign to a project; the project's client is applied automatically."),
        category_id: z.string().optional(),
        currency_id: z.string().optional().describe("Numeric currency id as string; omit for company currency."),
        exchange_rate: z.number().optional(),
        transaction_reference: z.string().optional().describe("Provider invoice/receipt number — also used for deduplication."),
        public_notes: z.string().optional(),
        private_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("expenses", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_update_expense",
    {
      title: "Update expense",
      description:
        "Partially update an expense (e.g. assign a project/category). Omitted fields are preserved — including " +
        "currency_id, which Invoice Ninja would otherwise reset to the company currency on every update.",
      inputSchema: {
        id: z.string().describe("Expense id (hashed string id)."),
        amount: z.number().optional(),
        date: z.string().optional(),
        vendor_id: z.string().optional(),
        client_id: z.string().optional(),
        project_id: z.string().optional().describe("Assign to a project; the project's client is applied automatically."),
        category_id: z.string().optional(),
        currency_id: z.string().optional(),
        transaction_reference: z.string().optional(),
        public_notes: z.string().optional(),
        private_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const { id, ...body } = a;
        if (!body.currency_id) {
          // IN's UpdateExpenseRequest resets an omitted currency_id to the
          // company currency — resend the current one to keep it stable.
          const current = (await client.get<Json>("expenses", id)).data;
          body.currency_id = current.currency_id as string;
        }
        return ok((await client.update("expenses", id, body)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_vendor",
    {
      title: "Create vendor",
      description: "Create a vendor (expense counterparty), e.g. a hosting or domain provider.",
      inputSchema: {
        name: z.string(),
        website: z.string().optional(),
        currency_id: z.string().optional().describe("Vendor's usual billing currency (numeric id as string)."),
        private_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("vendors", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_expense_category",
    {
      title: "Create expense category",
      description: "Create an expense category (e.g. Hosting, Domains, SaaS-Tools).",
      inputSchema: { name: z.string(), color: z.string().optional().describe("Hex color, e.g. #3f51b5.") },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("expense_categories", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----------------------------------------------------- tasks (write/track)
  const taskEntrySchema = z.object({
    start: z.number().int().describe("Start time, Unix epoch seconds."),
    end: z.number().int().default(0).describe("End time, epoch seconds. 0 = still running."),
    description: z.string().optional(),
  });

  function entriesToTimeLog(rows: { start: number; end: number; description?: string }[]): TimeEntry[] {
    return rows.map((r) => (r.description ? [r.start, r.end, r.description] : [r.start, r.end]));
  }

  server.registerTool(
    "in_create_task",
    {
      title: "Create task",
      description:
        "Create a time-tracking task. Optionally seed it with time entries. Omit entries and call " +
        "in_start_task to begin a live timer instead.",
      inputSchema: {
        description: z.string().optional().describe("Becomes the invoice line-item text."),
        client_id: z.string().optional(),
        project_id: z.string().optional(),
        rate: z.number().optional().describe("Hourly rate override; falls back to project/client/company default."),
        time_entries: z.array(taskEntrySchema).optional().describe("Pre-logged [start,end] sessions."),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const body: Json = {
          description: a.description,
          client_id: a.client_id,
          project_id: a.project_id,
          rate: a.rate,
        };
        if (a.time_entries?.length) {
          body.time_log = serializeTimeLog(entriesToTimeLog(a.time_entries));
        }
        return ok(enrichTask((await client.create<Json>("tasks", body)).data));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_start_task",
    {
      title: "Start task timer",
      description:
        "Start the clock on a task: appends an open time entry (end=0). No-op with a note if already running.",
      inputSchema: { id: z.string(), at: z.number().int().optional().describe("Start epoch (default now).") },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const task = (await client.get<Json>("tasks", a.id)).data;
        const entries = parseTimeLog(task.time_log);
        if (isRunning(entries)) {
          return ok({ ...enrichTask(task), note: "Task is already running; no change made." });
        }
        entries.push([a.at ?? nowEpoch(), 0]);
        const updated = (await client.update<Json>("tasks", a.id, { time_log: serializeTimeLog(entries) })).data;
        return ok(enrichTask(updated));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_stop_task",
    {
      title: "Stop task timer",
      description: "Stop a running task: closes the open time entry with an end timestamp.",
      inputSchema: { id: z.string(), at: z.number().int().optional().describe("Stop epoch (default now).") },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const task = (await client.get<Json>("tasks", a.id)).data;
        const entries = parseTimeLog(task.time_log);
        if (!isRunning(entries)) {
          return ok({ ...enrichTask(task), note: "Task is not running; nothing to stop." });
        }
        entries[entries.length - 1][1] = a.at ?? nowEpoch();
        const updated = (await client.update<Json>("tasks", a.id, { time_log: serializeTimeLog(entries) })).data;
        return ok(enrichTask(updated));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_log_time",
    {
      title: "Log time entry",
      description:
        "Append a completed time entry to a task after the fact (reconcile a past session). " +
        "Provide start and end epochs, or start + duration_minutes.",
      inputSchema: {
        id: z.string(),
        start: z.number().int().describe("Start epoch seconds."),
        end: z.number().int().optional().describe("End epoch seconds."),
        duration_minutes: z.number().optional().describe("Used if end omitted."),
        description: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        const end = a.end ?? (a.duration_minutes ? a.start + Math.round(a.duration_minutes * 60) : undefined);
        if (end === undefined) return fail(new Error("Provide either 'end' or 'duration_minutes'."));
        const task = (await client.get<Json>("tasks", a.id)).data;
        const entries = parseTimeLog(task.time_log);
        entries.push(a.description ? [a.start, end, a.description] : [a.start, end]);
        const updated = (await client.update<Json>("tasks", a.id, { time_log: serializeTimeLog(entries) })).data;
        return ok(enrichTask(updated));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_task_action",
    {
      title: "Task lifecycle action",
      description:
        "Apply an action to a task: archive, restore, delete, or invoice (creates a draft invoice from the tracked time; the task must belong to a client).",
      inputSchema: {
        id: z.string(),
        action: z.enum(["archive", "restore", "delete", "invoice"]),
      },
      annotations: DESTRUCTIVE,
    },
    async (a) => {
      try {
        if (a.action === "invoice") {
          const task = (await client.get<Json>("tasks", a.id)).data;
          if (!task.client_id) {
            return fail(new Error("Task has no client; assign it to a client before invoicing it."));
          }
          const secs = totalSeconds(parseTimeLog(task.time_log));
          const hours = Math.round((secs / 3600) * 100) / 100;
          const invoice = (
            await client.create<Json>("invoices", {
              client_id: task.client_id,
              line_items: [
                {
                  type_id: "2", // task line item; task_id makes IN link task.invoice_id
                  task_id: a.id,
                  quantity: hours,
                  cost: Number(task.rate) || 0,
                  notes: task.description ?? "",
                },
              ],
            })
          ).data;
          return ok(invoice);
        }
        // Tasks have no per-entity action route; archive/restore/delete go via bulk.
        const res = (await client.bulk<Json[]>("tasks", a.action, [a.id])).data;
        const updated = Array.isArray(res) ? res[0] : res;
        return ok(updated ? enrichTask(updated as Json) : res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "in_create_project",
    {
      title: "Create project",
      description: "Create a project to group tasks under a client.",
      inputSchema: {
        name: z.string(),
        client_id: z.string(),
        task_rate: z.number().optional(),
        budgeted_hours: z.number().optional(),
        due_date: z.string().optional().describe("Y-m-d."),
        public_notes: z.string().optional(),
      },
      annotations: WRITE,
    },
    async (a) => {
      try {
        return ok((await client.create("projects", a)).data);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
