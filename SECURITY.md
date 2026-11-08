# Security Policy

## Reporting a vulnerability

Do not open a public issue. Open a private security advisory on this repository:
[Security → Report a vulnerability](https://github.com/halviclabs/invoiceninja-mcp/security/advisories/new).
If you cannot use GitHub, write to hire@halvic.ch. Include the affected version, commit or image digest and the
steps to reproduce, using synthetic data; never put credentials or accounting data in a report.

You will get an acknowledgement within a few days. Fixes are released as a new version with a changelog entry
that credits the reporter, unless they prefer otherwise.

## Supported versions

Only the latest release receives fixes: the image `ghcr.io/halviclabs/invoiceninja-mcp:<X.Y.Z>` and the npm
package at the same version. Versions before 0.3.1 have known issues (see the changelog) and should be updated.

## Scope

The server exposes an Invoice Ninja company through MCP tools. The README's "Safety model" section describes the
design; in short:

- **Credentials** come from the environment (`INVOICE_NINJA_URL`, `INVOICE_NINJA_TOKEN`). The HTTP transport
  reads credentials from request headers only when the operator sets `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true`
  and `MCP_BEARER_TOKEN`; a request then has to carry both the address and the token, and the environment's token
  or API secret is never attached to a request-chosen address.
- **HTTP transport**: requests carry `Authorization: Bearer <MCP_BEARER_TOKEN>`. Run it behind TLS and do not
  expose it without the bearer.
- **Writes** are off by default. With writes on, `INVOICE_NINJA_SAFE_MODE=true` leaves out sending, settling,
  cancelling, deleting and payments, and `INVOICE_NINJA_DISABLED_TOOLS` removes any tool by name.
- **Filesystem access**: `in_upload_document` reads a file from the machine the server runs on. It is never
  registered on the HTTP transport. On stdio (Claude Desktop, Claude Code) it reads what the local user can
  read; disable it with `INVOICE_NINJA_DISABLED_TOOLS=in_upload_document` if the host should not attach files.

## Out of scope

- Invoice Ninja itself: report to [invoiceninja/invoiceninja](https://github.com/invoiceninja/invoiceninja).
- Authorisation inside Invoice Ninja: a tool can do what the API token's user can do. Give the token the least
  rights the agent needs.

## Acknowledgements

- Romain Valtier, [TETRA](https://tetra-ai.com) — reported the two 0.3.0 HTTP issues fixed in 0.3.1 (environment
  token sent to a request-chosen host; `in_upload_document` reading arbitrary server files).
