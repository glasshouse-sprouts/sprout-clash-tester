# @clash-tester/core

Shared business logic for the Clash Tester. The CLI, desktop app, and MCP
server all sit on top of this package.

**Status:** M0 placeholder. Real exports land in M1 — see `../../PLAN.md`.

## What lives here (planned)

- **Engine runner.** Spawns the vendored Rust binary in `engine/`, passes a
  clash-set JSON, captures stdout, returns a parsed summary.
- **Project file I/O.** Load / save / validate `.clashproj` files.
- **Rule presets.** Loads `presets/*.json`, expands them against the user's
  registered IFC files.
- **Output writers.** Pretty stdout, `clashes.json`, `clashes.csv`.

## What does **not** live here

- BCF parsing / writing — the Rust engine owns BCF output.
- Electron / DOM code — that lives in `@clash-tester/desktop` (M5).
- MCP transport — that lives in `@clash-tester/mcp-server` (M4).
