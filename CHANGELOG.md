# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
A tag `vX.Y.Z` releases the matching section through `.github/workflows/release.yml`.

## [0.4.0] - Unreleased

Hardening release. The HTTP transport's configuration changes; read "Migrating from 0.3.x" before updating a
remote deployment. Stdio users need `INVOICE_NINJA_UPLOAD_DIR` only if they attach documents.

### Migrating from 0.3.x

- HTTP always requires `MCP_BEARER_TOKEN`. There is no unauthenticated HTTP mode.
- Add your proxy's public hostname to `MCP_ALLOWED_HOSTS`; loopback names are allowed by default. Browser requests
  that send `Origin` also require an exact `MCP_ALLOWED_ORIGINS` entry.
- Request-credentials mode requires `INVOICE_NINJA_ALLOWED_URLS`, a comma-separated list of exact, operator-approved
  base URLs (scheme, port and base path included; no wildcards). Every request still needs both credential headers;
  environment secrets are never mixed in.
- Upstream URLs must use HTTPS. A trusted local or private HTTP instance requires explicit
  `INVOICE_NINJA_ALLOW_HTTP=true`. Redirects are refused: configure the final canonical base URL.
- Local stdio uploads require `INVOICE_NINJA_UPLOAD_DIR`. Copy intended documents into a dedicated staging
  directory; uploads outside it, symlink escapes, special files and oversized files (`INVOICE_NINJA_MAX_UPLOAD_BYTES`,
  default 10 MiB) are refused. Without the variable the tool is not registered. HTTP uploads remain unavailable.
- JSON-RPC batching is no longer supported. Send one message per request.
- Supported Node runtimes are 22, 24 and 26 (`engines`); the image uses Node 24.

### Security

- Destination allowlist (`INVOICE_NINJA_ALLOWED_URLS`) for request credentials, HTTPS-only upstreams with an explicit
  opt-in for HTTP, and no redirect following, so a bearer holder cannot steer the server at arbitrary hosts.
- Record IDs are validated (`[A-Za-z0-9_-]{1,128}`) and URL-encoded as single path segments; a tool input cannot
  select a different API path.
- Bounded inputs (string length, collection size, nesting depth, total elements), request body size, response size
  and duration, plus per-process rate and concurrency limits on HTTP.
- Host and Origin checks (`MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`); duplicate credential headers are refused.
- Errors return fixed, bounded messages; upstream bodies, filesystem errors and credentials are never echoed.
- Container: `compose.yaml` with read-only root filesystem, dropped capabilities, no privilege escalation and
  memory/CPU/pid caps; the Node base image is pinned by digest. The image build runs the type check and tests.

### Changed

- Invoice Ninja error responses pass their `message` and per-field `errors` to the model (strings only, bounded in
  number and length), so a 422 says which field was rejected; nothing else from an upstream body is returned.
- `/healthz` answers before the Host and Origin policy, so probes arriving with a pod IP or service name as Host
  succeed. In request-credentials mode the rate limit applies per request token instead of per process.
- JSON-RPC errors keep their code and message (bounded to 512 characters); an empty numeric environment variable
  means "unset" instead of failing startup; a configuration error at HTTP start prints one line and exits 1.

### Added

- `src/security.ts` (input bounds, path-segment validation) and `test/hardening.test.ts` covering each item above.
- `tsconfig.test.json`: tests are type-checked by `npm run typecheck`.

## [0.3.1] - 2026-11-08

Security release. Users of 0.3.0 who run the HTTP transport should update.

### Security

- **The environment's Invoice Ninja token could be sent to a host chosen in a request header.** With
  `MCP_BEARER_TOKEN` set and `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS` unset, a bearer-authenticated request
  carrying only `X-Invoice-Ninja-Url` made the server call that address with `INVOICE_NINJA_TOKEN`. The credential
  headers are now read only with `INVOICE_NINJA_REQUIRE_REQUEST_CREDENTIALS=true` (which in turn requires
  `MCP_BEARER_TOKEN`), a request has to carry the address and the token together, and the environment's token and
  API secret are never attached to a request-chosen address.
- **`in_upload_document` could read any file the server process can read**, including `/proc/self/environ` on the
  HTTP server. The tool is no longer registered on the HTTP transport. On stdio it still attaches local files;
  disable it with `INVOICE_NINJA_DISABLED_TOOLS` if the host should not.

Both reported by Romain Valtier, [TETRA](https://tetra-ai.com). Thank you.

- Dependencies updated to clear all open advisories: `@modelcontextprotocol/sdk` ^1.32.2 (from ^1.29.0), `zod`
  ^4.6.7 (from ^4.4.3) and their transitives (`hono`, `@hono/node-server`, `express`, `body-parser`, `qs`,
  `fast-uri`, `ip-address`). Supersedes Dependabot PRs #5–#10. `npm audit` is clean; CI now fails on a
  high-severity advisory.

### Fixed

- The container image is readable by its non-root user regardless of the build host's umask (a host with
  `umask 077` produced an image whose `package.json` the server could not open).

### Changed

- The package is `@halviclabs/invoiceninja-mcp` on npm, so hosts run it with `npx -y @halviclabs/invoiceninja-mcp`
  instead of a path to a local build. A second bin, `invoiceninja-mcp-http`, starts the HTTP transport.
  Node 22 or newer is required (`engines`).

### Added

- `LICENSE` (MIT; `package.json` already said so).
- `SECURITY.md` with the private reporting channel, supported versions and scope.
- CI on every push and pull request: secrets scan (gitleaks), type check, tests on Node 22 and 24, and a smoke
  test of the built image (`initialize` + `tools/list` over streamable HTTP). A push to `main` publishes
  `ghcr.io/halviclabs/invoiceninja-mcp:main` and `:sha-<commit>`.
- Releases from a `vX.Y.Z` tag: the npm package is published with provenance, the image goes to
  `ghcr.io/halviclabs/invoiceninja-mcp` (`X.Y.Z`, `X.Y`, `X`, `latest`) and optionally to a private mirror, and a
  GitHub Release carries this changelog section.
- Dependabot for npm, GitHub Actions and the Docker base image.

## [0.3.0] - 2026-11-04

### Added

- Credentials per request on the HTTP transport (`X-Invoice-Ninja-Url`, `X-Invoice-Ninja-Token`,
  `X-Invoice-Ninja-Safe-Mode`) behind the bearer, for hosts that serve several Invoice Ninja accounts through one
  server. Superseded in 0.3.1 by the opt-in described above.

## [0.2.1] - 2026-11-04

### Security

- Pinned `proxy-addr` 2.0.8 (CVE-2026-90711) through an npm override.

## [0.2.0] - 2026-11-04

### Added

- Safe mode (`INVOICE_NINJA_SAFE_MODE`) and the tool deny list (`INVOICE_NINJA_DISABLED_TOOLS`).
- Container image published to a private registry from a version tag.

[0.4.0]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/halviclabs/invoiceninja-mcp/releases/tag/v0.2.0
