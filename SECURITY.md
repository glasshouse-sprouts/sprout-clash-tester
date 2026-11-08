# Security policy

## Reporting a vulnerability

Please report security problems **privately** — do not open a public
issue.

Email **hello@glasshousebim.com** with:

- a description of the problem and its impact,
- steps to reproduce (or a proof of concept), and
- the version or commit you tested.

We will acknowledge your report as soon as we can, keep you updated, and
credit you when a fix ships (unless you prefer to stay anonymous). This
project is maintained on a best-effort basis, so we cannot promise fixed
response times.

## Supported versions

Clash Tester is in early development (0.x). Fixes go to `main`; please
test against the current `main` before reporting.

## Scope

Clash Tester runs locally. Reports are especially welcome about:

- **Untrusted input files.** IFC files and `.clashproj` project files are
  parsed by the engine and the TypeScript packages; a file that crashes,
  hangs or misleads a user who opens it is in scope.
- **The desktop app's MCP server** (`clash-tester-ui`). It listens on
  `127.0.0.1:7712` only and rejects requests with a foreign `Host` header
  or any browser `Origin`, so that web pages can't drive the app. A way
  around that, or a way for a tool call to reach files or commands it
  shouldn't, is in scope. See [`docs/MCP.md`](docs/MCP.md).
- **The headless MCP server** (`clash-tester`), which reads and writes
  files the agent names on behalf of the local user.

Out of scope: problems that need an attacker who already controls the
user's account or machine.
