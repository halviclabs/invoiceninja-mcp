# invoiceninja-mcp

A **self-hosted MCP server for Invoice Ninja v5** — built to talk only to *your*
instance, with no third-party SaaS bridge in the data path. Runs locally over
stdio (Claude Desktop / Claude Code) or remotely over streamable HTTP on your own
box (e.g. Exoscale Zürich).

## Why this exists

The existing options all have a catch:

| Option | Problem for a sovereignty-first setup |
|---|---|
| Zapier / viaSocket / Pipedream MCP | Hosted on US infra, per-call task billing — your invoice data transits a third party |
| `a-wiseguy/invoiceninja-mcp` (Python) | Read-only; writes never implemented; pinned to one IN build |
| `invoice-ninja-mcp-server` (npm) | Single unverified v1.0.0 release |
| Official IN MCP | Requested (issue #11843) but does not exist yet |

This server is standalone (no modification to Invoice Ninja), covers **read + write**,
gates all mutations behind an explicit flag, and deploys anywhere Node runs.

## Tools

**Read (always on):**
`in_ping`, `in_list_clients`, `in_get_client`, `in_list_invoices`, `in_get_invoice`,
`in_list_quotes`, `in_list_payments`, `in_list_products`, `in_list_expenses`,
`in_outstanding_summary` (aggregated AR / overdue totals + top debtors),
`in_list_tasks`, `in_get_task`, `in_list_projects`.

**Write (only when `INVOICE_NINJA_ALLOW_WRITES=true`):**
`in_create_client`, `in_update_client`, `in_create_invoice`, `in_invoice_action`
(mark_sent / mark_paid / archive / restore / delete / cancel / email),
`in_create_payment`, `in_create_quote`, `in_create_product`, `in_create_expense`,
`in_create_task`, `in_start_task`, `in_stop_task`, `in_log_time`, `in_task_action`
(archive / restore / delete / **invoice**), `in_create_project`.

List results are projected to key fields to keep model context lean; use the
`in_get_*` tools for full records.

## Time tracking

Invoice Ninja tracks work time through **Tasks** (a task is a time entry billed at
an hourly rate), optionally grouped under **Projects**. This server exposes the
full loop:

- **Live timer:** `in_start_task` appends an open entry; `in_stop_task` closes it.
  A task with an open entry is *running*.
- **After the fact:** `in_log_time` appends a completed session — pass `start` +
  `end`, or `start` + `duration_minutes`.
- **Seed on creation:** `in_create_task` can take `time_entries` up front.
- **Bill it:** `in_task_action` with `action: "invoice"` turns tracked time into
  an invoice line item.

Read tools decode the raw `time_log` for you and add `tracked_seconds`,
`tracked_hms` (e.g. "1h 30m") and a `running` flag. Internally, `time_log` is a
JSON string of `[start_epoch, end_epoch]` pairs with `end = 0` meaning still
running — the server handles that encoding, you work in plain timestamps.

Note: starting/stopping/logging time are **writes**, so they require
`INVOICE_NINJA_ALLOW_WRITES=true`.

## Setup

```bash
npm install
cp .env.example .env     # fill in INVOICE_NINJA_URL + INVOICE_NINJA_TOKEN
npm run build
```

Get the token in Invoice Ninja under **Settings → Account Management →
Integrations → API Tokens**. `INVOICE_NINJA_URL` is the bare instance URL — do
**not** append `/api/v1` (it's added for you).

### Claude Desktop (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "invoiceninja": {
      "command": "node",
      "args": ["/abs/path/to/invoiceninja-mcp/dist/index.js"],
      "env": {
        "INVOICE_NINJA_URL": "https://invoicing.example.ch",
        "INVOICE_NINJA_TOKEN": "your-company-token",
        "INVOICE_NINJA_ALLOW_WRITES": "false"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add invoiceninja -- node /abs/path/to/invoiceninja-mcp/dist/index.js
```

(set the env vars in the shell or via `--env` flags)

### Remote (streamable HTTP, self-hosted)

```bash
MCP_BEARER_TOKEN="$(openssl rand -hex 32)" npm run start:http
```

Listens on `127.0.0.1:8787/mcp` with `/healthz` for probes. Terminate TLS at your
proxy. Caddy example:

```
invoicing-mcp.example.ch {
    reverse_proxy 127.0.0.1:8787
}
```

Always set `MCP_BEARER_TOKEN` for remote exposure — clients send
`Authorization: Bearer <token>`.

## Safety model

- Writes are **off by default**. Read-only is the safe baseline.
- Write tools carry `destructiveHint` annotations so the host can prompt before
  executing lifecycle actions.
- Reminder: **updating a client requires resending the full `contacts` array**
  (with each contact `id`) — Invoice Ninja replaces contacts wholesale. The
  `in_update_client` description states this; honour it or you'll drop contacts.

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `INVOICE_NINJA_URL` | — (required) | Instance base URL, no `/api/v1` |
| `INVOICE_NINJA_TOKEN` | — (required) | Company API token |
| `INVOICE_NINJA_SECRET` | — | Optional `X-Api-Secret` |
| `INVOICE_NINJA_ALLOW_WRITES` | `false` | Enable mutating tools |
| `INVOICE_NINJA_MAX_PER_PAGE` | `100` | Cap on rows per list call |
| `INVOICE_NINJA_TIMEOUT_MS` | `30000` | Per-request timeout |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | HTTP transport bind |
| `MCP_BEARER_TOKEN` | — | Bearer auth for HTTP transport |

## Alternative: bake it into Laravel

Since Invoice Ninja is itself Laravel and `laravel/mcp` now exists, you could
instead expose these tools from a Laravel control plane and reuse Invoice Ninja's
own models/policies. That couples you to the IN codebase and its release cadence.
This standalone server stays decoupled and works against hosted or self-hosted
instances alike — generally the better choice unless you're already extending IN
in-process.

## Roadmap

- Recurring invoices + subscriptions
- Per-project time & budget reporting (hours logged vs budgeted_hours)
- Document/attachment upload (multipart)
- Tax-period reporting tool (quarterly VAT)
- `outputSchema` on tools for structured-content clients

MIT licensed.
