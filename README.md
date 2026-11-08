# Invoice Ninja MCP Server

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

The story behind it — why a chat-driven invoicing workflow, what the write-gating looks
like in daily use, and Invoice Ninja REST API examples in curl and Python — is in the
blog post [Automate invoicing with MCP: my Invoice Ninja server](https://halvic.ch/en/blog/automate-your-invoicing-with-mcp)
(German: [Buchhaltung automatisieren mit MCP](https://halvic.ch/de/blog/buchhaltung-automatisieren-mit-mcp)).

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

`in_upload_document` is available only over local stdio with writes enabled. It reads files accessible
to the local process. HTTP never exposes this tool, including when safe mode is off.

**Safe mode and a deny list.** `INVOICE_NINJA_SAFE_MODE=true` keeps writes on but leaves out
`in_invoice_action`, `in_quote_action` and `in_create_payment`, and narrows `in_task_action` to
`archive` and `restore`: the model prepares drafts, clients, expenses, tasks and time entries, and
people send, settle, cancel and delete in Invoice Ninja. `INVOICE_NINJA_DISABLED_TOOLS` names
further tools to leave out, comma-separated. `in_ping` reports `safe_mode` next to `writes_enabled`,
and the token's company (`company: {id, name}`) where the instance tells.

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

Get an API token in Invoice Ninja under **Settings → Account Management → Integrations → API Tokens**.
`INVOICE_NINJA_URL` is the bare instance URL — do **not** append `/api/v1` (it's added for you).

The server is published on npm as
[`@halviclabs/invoiceninja-mcp`](https://www.npmjs.com/package/@halviclabs/invoiceninja-mcp) (Node 22 or
newer) and as a container image (below). Nothing has to be cloned or built.

### Claude Desktop (stdio)

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "invoiceninja": {
      "command": "npx",
      "args": ["-y", "@halviclabs/invoiceninja-mcp"],
      "env": {
        "INVOICE_NINJA_URL": "https://invoicing.example.ch",
        "INVOICE_NINJA_TOKEN": "your-company-token",
        "INVOICE_NINJA_ALLOW_WRITES": "false"
      }
    }
  }
}
```

Pin a version (`"@halviclabs/invoiceninja-mcp@0.3.1"`) if updates should be deliberate.

### Claude Code

```bash
claude mcp add invoiceninja \
  -e INVOICE_NINJA_URL=https://invoicing.example.ch \
  -e INVOICE_NINJA_TOKEN=your-company-token \
  -- npx -y @halviclabs/invoiceninja-mcp
```

### From source

```bash
git clone https://github.com/halviclabs/invoiceninja-mcp.git && cd invoiceninja-mcp
npm ci && npm run build
cp .env.example .env                # fill in INVOICE_NINJA_URL + INVOICE_NINJA_TOKEN
node --env-file=.env dist/index.js  # stdio — or point the host config at this file
```

### Container

```bash
docker run --rm -p 8787:8787 -e HOST=0.0.0.0 -e INVOICE_NINJA_URL=https://invoicing.example.ch \
  -e INVOICE_NINJA_TOKEN=... -e INVOICE_NINJA_ALLOW_WRITES=true -e INVOICE_NINJA_SAFE_MODE=true \
  -e MCP_BEARER_TOKEN=... ghcr.io/halviclabs/invoiceninja-mcp:0.3.1
```

Released images are `ghcr.io/halviclabs/invoiceninja-mcp:<X.Y.Z>` (also `X.Y`, `X` and `latest`; pin the
digest in production). Every push to `main` additionally publishes `:main` and `:sha-<commit>`. The image runs
the HTTP transport as a non-root user with a read-only root filesystem and answers `/healthz`.
`docker build -t invoiceninja-mcp .` builds it locally.

### Remote (streamable HTTP, self-hosted)

```bash
MCP_BEARER_TOKEN="$(openssl rand -hex 32)" npx -y -p @halviclabs/invoiceninja-mcp invoiceninja-mcp-http
```

(or `npm run start:http` from a source checkout, with the `INVOICE_NINJA_*` variables set either way)

Listens on `127.0.0.1:8787/mcp` with `/healthz` for probes. Terminate TLS at your
proxy. Caddy example:

```
invoicing-mcp.example.ch {
    reverse_proxy 127.0.0.1:8787
}
```

Always set `MCP_BEARER_TOKEN` for remote exposure — clients send
`Authorization: Bearer <token>`.

### Credentials per request (several accounts, one server)

With `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true` and bearer authentication, a request carries
its own Invoice Ninja credentials, so one server serves any
number of companies or people. ALVIREQ runs it this way next to each instance: the administrator
connects the company token on the plugin page, people may connect their own, and every request
carries the token of the connection in use.

| Header | Value |
|---|---|
| `X-Invoice-Ninja-Url` | Base URL; `https://`, or `http://` on `127.0.0.1`/`localhost`. No user name, password, query; `/api/v1` is dropped |
| `X-Invoice-Ninja-Token` | API token |
| `X-Invoice-Ninja-Safe-Mode` | `false` allows sending and settling; any other value keeps safe mode on |

By default, all three headers are ignored and the server uses its environment configuration.
To enable them, set `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true`; `MCP_BEARER_TOKEN` must
also be set and match. `INVOICE_NINJA_SAFE_MODE=true` in the environment is a floor a request
cannot lower, and `INVOICE_NINJA_ALLOW_WRITES` still decides whether write tools exist at all.

In request-credentials mode, both URL and token must be present on every request. The environment's
`INVOICE_NINJA_URL`, `INVOICE_NINJA_TOKEN` and `INVOICE_NINJA_SECRET` are not used. Instances requiring
`X-Api-Secret` must use environment-credentials mode; there is no per-request API-secret header.
The server refuses to start without `MCP_BEARER_TOKEN`, and a request missing either URL or token gets
`400 {"error":"missing_credentials"}`. A refused address gets
`400 {"error":"invalid_url"}`, a repeated or malformed header `400 {"error":"invalid_header"}`;
nothing is sent to Invoice Ninja in either case. Tokens are never logged.

```bash
docker run --rm -p 8787:8787 -e HOST=0.0.0.0 -e INVOICE_NINJA_ALLOW_WRITES=true \
  -e INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true -e MCP_BEARER_TOKEN=... \
  ghcr.io/halviclabs/invoiceninja-mcp:0.3.1
```

## Safety model

- Writes are **off by default**. Read-only is the safe baseline.
- Write tools carry `destructiveHint` annotations so the host can prompt before
  executing lifecycle actions.
- Reminder: **updating a client requires resending the full `contacts` array**
  (with each contact `id`) — Invoice Ninja replaces contacts wholesale. The
  `in_update_client` description states this; honour it or you'll drop contacts.
- `in_upload_document` reads files from the machine the server runs on. It is never registered on the
  HTTP transport; on stdio, disable it with `INVOICE_NINJA_DISABLED_TOOLS` if the host should not attach files.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); fixed issues and their reporters
are listed there and in the [changelog](CHANGELOG.md).

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `INVOICE_NINJA_URL` | — (required¹) | Instance base URL, no `/api/v1` |
| `INVOICE_NINJA_TOKEN` | — (required¹) | Company API token |
| `INVOICE_NINJA_SECRET` | — | Optional `X-Api-Secret`; environment credentials only |
| `INVOICE_NINJA_ALLOW_WRITES` | `false` | Enable mutating tools |
| `INVOICE_NINJA_SAFE_MODE` | `false` | With writes on, leave out sending, settling, cancelling, deleting and payments; a floor for requests |
| `INVOICE_NINJA_DISABLED_TOOLS` | — | Tool names never registered, comma-separated |
| `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS` | `false` | HTTP only: address and token only from request headers (needs `MCP_BEARER_TOKEN`) |
| `INVOICE_NINJA_MAX_PER_PAGE` | `100` | Cap on rows per list call |
| `INVOICE_NINJA_TIMEOUT_MS` | `30000` | Per-request timeout |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | HTTP transport bind |
| `MCP_BEARER_TOKEN` | — | Bearer auth for HTTP transport; required for request-credentials mode |

¹ Not with `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true`, which requires both values in request headers instead.

## Development

```bash
npm ci
npm run dev           # stdio transport straight from the sources (tsx), no build step
npm run dev:http      # HTTP transport, same
npm test && npm run typecheck && npm run build
```

CI (`.github/workflows/ci.yml`) runs a secrets scan, the type check, the tests on Node 22 and 24, `npm audit` and a
smoke test of the container image on every push and pull request. Pushes to `main` publish the `:main` image.

### Releasing

Bump `version` in `package.json` and `SERVER_VERSION` in `src/server.ts`, add the section to `CHANGELOG.md`, and
push a tag `vX.Y.Z`. `.github/workflows/release.yml` checks that the three agree, runs CI, publishes the npm package
with provenance, builds and smoke-tests the image, pushes it to GHCR (and to a private mirror when the repository
variable `RELEASE_MIRROR_IMAGE` is set), and creates the GitHub Release from the changelog section.

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
- Document upload confined to a configured staging directory (stdio)
- Tax-period reporting tool (quarterly VAT)
- `outputSchema` on tools for structured-content clients

## Author

Built by [Halvic Labs](https://halvic.ch) — a Swiss AI-engineering workshop.
More on building MCP servers: [Write your first MCP server](https://halvic.ch/en/blog/write-your-first-mcp-server).

MIT licensed.
