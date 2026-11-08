# Architecture

What Clash Tester is, how it is put together, and the few choices that
shape everything else. How a clash is decided:
[`HOW-IT-WORKS.md`](HOW-IT-WORKS.md). The project file:
[`PROJECT-FILE.md`](PROJECT-FILE.md). The MCP servers: [`MCP.md`](MCP.md).

## Purpose

A small, standalone tool that runs IFC clash detection, three ways:

- **CLI** — one command turns IFC files + a rule set into a BCF/JSON/CSV
  report.
- **Desktop app** — pick files, pick rules, run, browse the results.
- **MCP server** — the same workflow as tools an AI agent can call.

The clash engine comes from [Clashero](https://github.com/bruadam/clashero)
(Rust). This project builds the shell, the UX and the integration around
it, plus engine work of its own (opening cuts, self checks, grouping, an
optional ifc-lite narrow phase).

## Non-goals

- Not a BIM platform: no database, dashboard, issue-tracker sync or auth.
- Not a 3D viewer. It writes files that BIM viewers open.
- Not a general rules engine (no IDS validation). Clash detection only.
- No rendered BCF snapshots: topics carry a placeholder image.

## Components

```
  CLI ──────────┐
  Desktop app ──┼──► clash-core (TypeScript)
  MCP servers ──┘         │
                          ▼
                 spawns ─► clash binary (Rust, engine/)
                          │
                          ▼
                 BCF + JSON + CSV
```

- **Engine** (`engine/`, Rust) — loads IFC with
  [ifc-lite](https://crates.io/crates/ifc-lite-core), meshes elements
  (openings cut out), selects each rule's two sides, finds clashes, writes
  BCF and a JSON summary. CLI: `clash detect`, `clash check-alignment`,
  `clash bcf`.
- **clash-core** (`packages/clash-core`, TypeScript) — the only place with
  business logic: project files, presets, spawning the engine and reading
  its summary, grouping, JSON/CSV writers. Browser-safe parts
  (`/grouping`, `/settings`, `/types`, `/discipline`) are also used by the
  desktop renderer.
- **CLI** (`packages/cli`) — `clashtester init | validate | run`.
- **MCP server** (`packages/mcp-server`) — headless, stdio, works on its
  own project file.
- **Desktop app** (`packages/desktop`) — Electron (electron-vite + React +
  Tailwind). Main process: window, file dialogs, runs via clash-core, and
  a second MCP server that acts on the open app. Renderer: the Files,
  Rules and Results views.

## Key choices

- **Engine derived from Clashero.** `engine/` started as a copy of
  Clashero's `clash/` crate and is maintained here; there is no runtime
  dependency on Clashero. See [`engine/VENDORED.md`](../engine/VENDORED.md)
  and [`NOTICE`](../NOTICE).
- **Everything in metres after load.** Each file's length unit is applied
  once, in the loader; from there all geometry, thresholds and outputs are
  metres.
- **The IFC's own coordinate frame.** Clash points and BCF cameras are in
  the IFC world frame (Z-up, metres); `IfcMapConversion` is not applied.
  Models are expected to share an origin; a per-file translation handles
  offsets, rotation is not supported.
- **One BCF writer.** The engine writes all BCF, also the per-group topics
  clash-core computes.
- **One code path for people and agents.** The desktop app's MCP server
  edits the project through the same functions as the UI.

## Platforms

Developed and tested on macOS. Electron, Node and Rust all run on Linux
and Windows, but those are not tested yet. No packaged installers yet.

## Repository layout

```
engine/                 Rust engine (+ tests/models: test IFC files)
packages/
  clash-core/           shared TypeScript library
  cli/                  clashtester CLI
  mcp-server/           headless MCP server (stdio)
  desktop/              Electron app (+ bin/: stdio bridge to its MCP)
presets/                preset rules (JSON)
examples/               runnable example projects
docs/                   these documents
scripts/                MCP config printer, licence report
```

Tests: `cargo test --release` in `engine/`; `npm test` at the root (Vitest;
set `CLASH_BINARY=engine/target/release/clash` for the end-to-end tests).
