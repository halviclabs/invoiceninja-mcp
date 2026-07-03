# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone MCP (Model Context Protocol) server that exposes a self-hosted **Invoice Ninja v5** instance to MCP hosts (Claude Desktop, Claude Code). It talks only to the operator's own Invoice Ninja instance via its REST API — no third-party SaaS bridge. TypeScript, ESM, Node ≥18, no runtime deps beyond `@modelcontextprotocol/sdk` and `zod`.

## Commands

```bash
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit (use this to check work; there is no test suite)
npm run dev          # tsx src/index.ts  — stdio transport, no build step
npm run dev:http     # tsx src/http.ts   — HTTP transport, no build step
npm start            # node dist/index.js (stdio, requires build)
npm run start:http   # node dist/http.js (HTTP, requires build)
```

There are no tests, linter, or formatter configured. `npm run typecheck` is the only verification gate — run it after changes.

Required env to run: `INVOICE_NINJA_URL` and `INVOICE_NINJA_TOKEN` (see `.env.example`). Note: nothing in the code loads a `.env` file automatically — env vars must be set in the shell, via the MCP host config, or with `node --env-file=.env`.

## Architecture

Layered, single-responsibility modules under `src/`:

- **`config.ts`** — `loadConfig()` reads/validates env into a `Config`. Normalises `INVOICE_NINJA_URL` by stripping a trailing `/api/v1`. `allowWrites` defaults **false**.
- **`client.ts`** — `InvoiceNinjaClient`, a thin typed wrapper over the IN v5 REST API. Generic `list/get/create/update/action/bulk` over any entity collection. Every request carries `X-API-TOKEN` + `X-Requested-With: XMLHttpRequest` (the latter is mandatory or IN returns HTML redirects). Throws `InvoiceNinjaError` carrying status + body.
- **`timelog.ts`** — pure helpers for Invoice Ninja's `time_log` encoding (see below). No I/O; fully unit-testable.
- **`tools.ts`** — `registerTools(server, cfg)`. The heart of the project: defines every MCP tool, its zod `inputSchema`, and its handler. This is where you add or change tools.
- **`server.ts`** — `createServer()` wires config + tools into an `McpServer`. Shared by both transports.
- **`index.ts`** — stdio transport entry (Claude Desktop / Code).
- **`http.ts`** — streamable-HTTP transport entry (remote/self-hosted), stateless (fresh server+transport per POST), optional `MCP_BEARER_TOKEN` auth, `/healthz` probe.

Both entry points call the same `createServer()`; transport is the only difference.

## Key conventions (follow these when editing `tools.ts`)

- **Read vs write gating:** read tools register unconditionally. `registerTools` returns early (`if (!cfg.allowWrites) return`) before defining any write tool, so writes are physically absent unless `INVOICE_NINJA_ALLOW_WRITES=true`. Keep new write tools below that guard.
- **Tool annotations:** read tools get `{ readOnlyHint: true }`. Writes get `WRITE` (`destructiveHint: false`) or `DESTRUCTIVE` (`destructiveHint: true`, for lifecycle/delete actions) so hosts can prompt before executing.
- **List projection:** list handlers project rows down to a small `*_FIELDS` allowlist (`project()`) to keep model context lean. Full records come from the `in_get_*` tools. When adding a field to a list, add it to the relevant `*_FIELDS` constant.
- **Response helpers:** always return via `ok(payload)` / `fail(err)`. Every handler wraps its body in `try/catch` and returns `fail(e)` — `fail` understands `InvoiceNinjaError` and surfaces status + details.
- **`per_page` is capped** server-side at `cfg.maxPerPage` inside `client.list`; the schema max (1000) is just input validation.
- Tools are named `in_<verb>_<entity>` (e.g. `in_list_invoices`, `in_create_payment`).

## Invoice Ninja domain gotchas

- **`time_log` encoding:** a task's time entries are a JSON-encoded **string** of `[start_epoch, end_epoch]` pairs (seconds), `end === 0` meaning still running. Newer builds append extra elements (description, billable) per entry — `timelog.ts` only ever touches indices 0/1 and preserves the rest. Always round-trip through `parseTimeLog` / `serializeTimeLog`; read tools enrich tasks via `enrichTask` (adds `tracked_seconds`, `tracked_hms`, `running`).
- **Updating a client replaces contacts wholesale:** `in_update_client` must resend the FULL `contacts` array (each with its `id`) or contacts get dropped. This is reflected in the tool description and the server `instructions` — preserve that warning.
- **IDs are hashed strings**, not the human-facing display `number`. Tools take the hashed `id`.
- **Lifecycle actions** go through `PUT /<entity>/<id>?action=<verb>` (`client.action`), e.g. invoice `mark_sent`/`mark_paid`/`cancel`, task `invoice` (turns tracked time into an invoice line item).
- Email lives on the **contact**, not the client.

## stdio transport caveat

On the stdio transport (`index.ts`), **never write to stdout** — it corrupts the JSON-RPC stream. Use `process.stderr` for any logging.