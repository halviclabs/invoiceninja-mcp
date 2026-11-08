# Security Policy

## Reporting a vulnerability

Do not open a public issue. Open a private security advisory on this repository:
[Security → Report a vulnerability](https://github.com/halviclabs/invoiceninja-mcp/security/advisories/new).
If you cannot use GitHub, write to hire@halvic.ch. Include the affected version, commit or image digest and the
steps to reproduce, using synthetic data; never put credentials or accounting data in a report.

You will get an acknowledgement within a few days. Fixes are released as a new version with a changelog entry
that credits the reporter, unless they prefer otherwise.

## Supported versions

Only the latest release receives fixes: the npm package `@halviclabs/invoiceninja-mcp@<X.Y.Z>` and the image
`ghcr.io/halviclabs/invoiceninja-mcp:<X.Y.Z>`. Versions before 0.3.1 have known issues (see the changelog) and
should be updated; 0.4.0 changes the HTTP configuration (see "Migrating from 0.3.x" in the changelog).

## Scope

The server exposes an Invoice Ninja company through MCP tools. The README's "Safety model" section describes the
design; in short:

- **Credentials** come from the environment (`INVOICE_NINJA_URL`, `INVOICE_NINJA_TOKEN`). The HTTP transport
  reads credentials from request headers only when the operator sets `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true`;
  a request then has to carry both the address and the token, the address must be an exact entry of
  `INVOICE_NINJA_ALLOWED_URLS`, and the environment's token or API secret is never attached. Upstream addresses must
  use HTTPS unless `INVOICE_NINJA_ALLOW_HTTP=true` names a trusted local instance; redirects are never followed.
- **HTTP transport**: `MCP_BEARER_TOKEN` is always required — there is no unauthenticated HTTP mode. Requests must
  match `MCP_ALLOWED_HOSTS` (loopback names by default) and, when they send `Origin`, `MCP_ALLOWED_ORIGINS`.
  Request bodies, strings, collections, nesting depth, response sizes and durations are bounded; rate and
  concurrency limits apply per process. JSON-RPC batching is not accepted.
- **Writes** are off by default. With writes on, `INVOICE_NINJA_SAFE_MODE=true` leaves out sending, settling,
  cancelling, deleting and payments, and `INVOICE_NINJA_DISABLED_TOOLS` removes any tool by name. Safe mode from the
  environment is a floor a request cannot lower.
- **Filesystem access**: `in_upload_document` exists only on the stdio transport and only when
  `INVOICE_NINJA_UPLOAD_DIR` names a staging directory; files outside it, symlink escapes, special files and
  oversized files are refused. HTTP never registers the tool.

## Security boundaries

Record IDs must match `[A-Za-z0-9_-]{1,128}` and are encoded as individual URL segments. Read tools cannot select a
different API path through an ID. The API token's backend permissions still apply. Write tools remain opt-in, safe
mode is an environment-controlled floor, and the tool deny list is applied before registration.

The exact destination allowlist trusts the operator-approved service's hostname and DNS. It is not a replacement for
network egress restrictions. Permit only intended Invoice Ninja destinations and do not allow untrusted parties to
control allowlisted DNS. Private instances can be explicitly allowlisted.

Bearer holders can access the tools available to their connection. The shared HTTP bearer is not a per-user identity
system. Apply user authorization in the gateway or use separate processes/tokens. Process-local rate/concurrency
limits do not aggregate across replicas; configure gateway limits too.

Response size and timeout limits apply to JSON and uploads, including body consumption. API calls never follow
redirects. Errors return fixed, bounded messages and statuses; raw upstream errors, native filesystem errors and
credentials are not exposed to callers.

The container runs as a non-root user with root-owned code. `compose.yaml` additionally sets a read-only root
filesystem, drops capabilities, prevents privilege escalation, and caps memory, CPU and processes. Use equivalent
restrictions when deploying without Compose. TLS termination and network policy remain deployment responsibilities.

## Out of scope

- Invoice Ninja itself: report to [invoiceninja/invoiceninja](https://github.com/invoiceninja/invoiceninja).
- Authorisation inside Invoice Ninja: a tool can do what the API token's user can do. Give the token the least
  rights the agent needs.

## Maintenance and validation

CI (`.github/workflows/ci.yml`) scans the history for secrets, type-checks source and tests, runs the regression
tests on the supported Node versions, builds the package, audits dependencies and smoke-tests the container image.
Releases depend on that validation. Actions are pinned to commits and the Node base image to a digest; Dependabot
maintains update proposals.

`test/security.test.ts` covers the HTTP credential isolation and upload boundary from 0.3.1; `test/hardening.test.ts`
covers path injection, resource limits, destination policy, HTTP authentication and Host/Origin checks, duplicate
headers, redirect disclosure, response deadlines and byte caps, error sanitisation, and bounded staging-directory
uploads.

## Acknowledgements

- Romain Valtier, [TETRA](https://tetra-ai.com) — reported the two 0.3.0 HTTP issues fixed in 0.3.1 (environment
  token sent to a request-chosen host; `in_upload_document` reading arbitrary server files).
