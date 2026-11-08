# @clash-tester/core

Shared logic for Clash Tester. The CLI, the desktop app and the MCP server
all sit on top of this package.

- **Runner** (`run`, `checkAlignment`) — spawns the Rust `clash` binary
  from `engine/`, passes the rules as clash-set JSON and reads back the
  JSON summary it writes.
- **Project files** — load / save / validate `.clashproj`, and expand its
  rules (presets included) to the engine's format.
- **Presets** — loads `presets/*.json` and matches them to the project
  files' disciplines.
- **Grouping** — turns the clash list into groups (pairs, clash groups,
  possible double modelling, optional areas).
- **Writers** — `clashes.json`, `clashes.csv`, and the BCF topic list for
  per-group BCF.

BCF itself is written by the Rust engine. Browser-safe sub-paths for the
desktop renderer: `@clash-tester/core/grouping`, `/settings`, `/types`,
`/discipline`.

Design notes: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).
