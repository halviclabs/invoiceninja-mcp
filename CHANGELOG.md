# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
A tag `vX.Y.Z` releases the matching section through `.github/workflows/release.yml`.

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

- Dependencies updated within their ranges to clear all open advisories: `@modelcontextprotocol/sdk` 1.32.2
  (from 1.29.0), `zod` 4.6.7 (from 4.4.3) and their transitives (`hono`, `@hono/node-server`, `express`,
  `body-parser`, `qs`, `fast-uri`, `ip-address`). `npm audit` is clean; CI now fails on a high-severity advisory.

### Fixed

- The container image is readable by its non-root user regardless of the build host's umask (a host with
  `umask 077` produced an image whose `package.json` the server could not open).

### Added

- `SECURITY.md` with the private reporting channel, supported versions and scope.
- CI on every push and pull request: secrets scan (gitleaks), type check, tests on Node 22 and 24, and a smoke
  test of the built image (`initialize` + `tools/list` over streamable HTTP). A push to `main` publishes
  `ghcr.io/halviclabs/invoiceninja-mcp:main` and `:sha-<commit>`.
- Releases from a `vX.Y.Z` tag: the image goes to `ghcr.io/halviclabs/invoiceninja-mcp` (`X.Y.Z`, `X.Y`, `X`,
  `latest`) and optionally to a private mirror, and a GitHub Release carries this changelog section.
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

[0.3.1]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/halviclabs/invoiceninja-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/halviclabs/invoiceninja-mcp/releases/tag/v0.2.0
