# Clash Tester

A small, standalone IFC clash detection tool. Runs as CLI, desktop app
(Electron), and MCP server.

> **Status: M5 (desktop app) complete.** Engine + Node runner + CLI +
> preset library + `--json` + MCP server + Electron desktop app all
> working. Try the CLI: `clashtester run examples/tiny-project/sample.clashproj`.
> Try the desktop app: `cd packages/desktop && npm run dev`. See
> `M4_PROGRESS.md` for Claude Desktop wiring and `M5_PROGRESS.md` for
> the desktop app. Read `SPEC.md`, `PLAN.md`, and the `Mn_PROGRESS.md`
> files for full context.

## Origins and credits

Clash Tester stands on the shoulders of
[Clashero](https://github.com/bruadam/clashero). Its Rust clash engine is
the foundation of ours: the `engine/` folder started as a copy of
Clashero's `clash/` crate, and most of that code — IFC loading, selectors,
the collision engine, BCF writing, the CLI — is still recognisably theirs.
Thank you to the Clashero contributors for building it and sharing it under
the MIT licence.

Clashero's discipline tables also shaped our preset rules, and its MCP
tool set shaped ours.

What we added on top is a leaner shell around that engine: a focused CLI,
a small Electron app, an MCP server an AI agent can drive, and engine work
of our own (opening cuts, self checks, clash grouping, an optional ifc-lite
narrow phase). The dashboard, database and project-management parts of
Clashero are not part of this tool.

Licence and copyright notice for Clashero: see [`NOTICE`](NOTICE). Where
the copy came from and how we maintain it: see
[`engine/VENDORED.md`](engine/VENDORED.md).

## What it does (when finished)

- You give it one or more IFC files and a set of clash rules.
- It finds where the geometry collides.
- It writes the results as **BCF** (opens in BIM viewers), **JSON** (for
  agents / scripts), and **CSV** (for spreadsheets).

## Project files

- `SPEC.md` — what the tool is and isn't, the architecture, open questions.
- `PLAN.md` — milestones from scaffold to shippable release.
- `M0_PROGRESS.md` — repo scaffold + vendored engine.
- `M1_PROGRESS.md` — engine baseline cleanup + translation + AABB warning + Node runner.
- `M2_PROGRESS.md` — CLI commands (`init`, `validate`, `run`) + JSON/CSV writers + sample project.
- `M3_PROGRESS.md` — preset library + source-IFC-per-clash + `--json` + `init --preset`.
- `M4_PROGRESS.md` — MCP server (9 tools, stdio transport, Claude Desktop wiring).
- `M5_PROGRESS.md` — Electron desktop app (three views, drag-and-drop, IPC bridge).
- `README.md` — this file. High-level orientation only.
- `engine/VENDORED.md` — origin of the vendored Rust engine.

## Decisions so far

| Decision | Choice | Why |
|---|---|---|
| Clash engine | Vendored copy of Clashero's Rust engine | Already works, tested, fast on big models. Vendoring keeps us 100% independent — no external dependency, no submodule. |
| Coordinate alignment | Translation override only, default zero | Models assumed to be coordinated. Translation handles edge cases. AABB-overlap sanity warning catches silent misalignment. Rotation is out of scope. |
| Rule UX | Preset library + custom override | Familiar to BIM users; presets cover 90% of cases |
| MCP scope | Mirror Clashero's MCP (dashboard tools removed) | Battle-tested toolset |
| Outputs | BCF + JSON + CSV (always together) | Covers viewer, agent, and PM workflows |
| Project file format | `.clashproj` JSON | Stable, hand-editable, version-controllable |
| Platforms | macOS, Windows, Linux | Electron makes this cheap |
| Snapshots in BCF (v1) | Placeholder PNG | Same as Clashero; real screenshots is a v2 problem |
| Desktop stack | Mirrors Model Viewer (electron-vite + React + Tailwind) | Consistency across our tools |
| Name | "Clash Tester" stays | Descriptive, no time to bikeshed |

## Open questions still on the table (see SPEC §12)

1. Default output location — next to `.clashproj`? Downloads? Always ask?
2. Federated perf gate before v1 — yes / no?
3. MCP binary discovery — auto-resolve to `engine/target/release/clash` or a tool?
