# Clash Tester

Find where the geometry in your IFC models collides. Give Clash Tester one
or more IFC files and a set of clash rules; it writes the clashes as
**BCF** (for BIM viewers), **JSON** (for scripts and AI agents) and
**CSV** (for spreadsheets).

Three ways to use it, all on the same engine:

- **CLI** — `clashtester run project.clashproj`
- **Desktop app** — an Electron app: drop in IFC files, pick rules, run,
  browse the results.
- **MCP server** — lets an AI agent (e.g. Claude) register models, set
  rules, run detection and read the results. The desktop app has its own
  MCP server too, so an agent can see and drive the open app.

> **Status: early (0.x).** It works and is tested, but there are no
> packaged installers yet and the project file format may still change.
> This project is maintained on a best-effort basis. We welcome issues and
> PRs, but cannot guarantee response times.

## What it does

- **Presets and custom rules.** Presets such as `HVACxSTR` (ducts against
  beams and columns) match your files by discipline tag. Custom rules take
  an IFC type selector per side (`IfcDuct*`, `IfcWall|IfcSlab`, `*`).
- **Self check.** A model tested against itself: internal clashes and
  elements that are probably modelled twice.
- **Fewer false clashes.** Openings are cut out of walls and slabs before
  testing, and elements that belong together in the IFC (a door in its
  wall, parts of an assembly) are skipped.
- **Grouping.** Clashes are grouped into issues: one element pair, one
  element hitting many others, possible double modelling, and optionally
  nearby clashes. BCF can have one topic per clash or per group.
- **Alignment checks.** Warns when the models don't share a placement
  (e.g. different export origins), before and after detection.
- **Hard clashes or clearance.** Default: a hard overlap of at least 5 mm.
  Optionally a clearance distance instead.

## Documentation

| Document | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Purpose, components, key design choices, repository layout |
| [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) | How a clash is decided, step by step, and what is written |
| [`docs/PROJECT-FILE.md`](docs/PROJECT-FILE.md) | The `.clashproj` format: files, rules, selectors, settings |
| [`docs/MCP.md`](docs/MCP.md) | The two MCP servers: setup, tools, troubleshooting |

## Quick start

You need [Rust](https://rustup.rs) 1.85 or newer, [Node.js](https://nodejs.org)
20 or newer, and git. Developed on macOS; Linux and Windows should work
but are not tested yet.

```bash
git clone https://github.com/3dbyggeri/clash-tester.git
cd clash-tester
```

Build the Rust engine (the first build takes a few minutes):

```bash
cd engine && cargo build --release && cd ..
```

Install the Node packages and build them:

```bash
npm install
```

```bash
npm run build --workspaces --if-present
```

Run the example (two small buildingSMART sample models, ducts against
structure at 100 mm clearance):

```bash
node packages/cli/dist/index.js run examples/tiny-project/sample.clashproj
```

It prints a summary and writes `report.bcf`, `clashes.json` and
`clashes.csv` to `examples/tiny-project/outputs/`. A second example,
[`examples/self-check/`](examples/self-check), checks two models against
themselves.

To start your own project,
`node packages/cli/dist/index.js init my-project.clashproj` writes a sample
project file to edit (point its `files` at your IFCs); `run --help` lists
the options. The format: [`docs/PROJECT-FILE.md`](docs/PROJECT-FILE.md).

### Desktop app

```bash
cd packages/desktop && npm run dev
```

### MCP server

See [`docs/MCP.md`](docs/MCP.md): `npm run mcp:config` prints the
configuration block for Claude.

## Outputs

| File | Content |
|---|---|
| `report.bcf` | BCF 2.1: one topic per clash (or per group), with the clashing elements selected and a camera on the clash. Opens in BIMcollab, Solibri and other BIM tools. |
| `clashes.json` | Everything: clashes (types, GUIDs, files, position, depth or gap, …), groups, per-rule counts, warnings. |
| `clashes.csv` | One row per clash. |

Each clash has a number that is the same in all three: the BCF topic title
starts with it, and it is the first CSV column. Details:
[`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md#outputs).

## Known limits

- **No rotation.** Models are assumed to share a coordinate origin; a
  per-file translation handles offsets, rotation is not supported.
- **Placeholder BCF snapshots.** Topics carry a placeholder image, not a
  rendered view.
- **IFC2X3 MEP** elements are classified through their type objects
  (`IfcFlowSegment` typed as a duct counts as a duct). Elements without a
  type object can't be classified, and the run warns about them.
- **Depth is an estimate** with the default narrow phase: the smallest
  side of the bounding-box overlap, not the true penetration.
- **The ifc-lite narrow phase is experimental** (`--narrow-phase ifclite`).
  It separates touching faces from real clashes, but is not the default.
- **No installers yet.** The desktop app runs from source
  (`npm run dev`).

## Development

The repository layout is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#repository-layout).
Tests: `cargo test --release` in `engine/`, and `npm test` at the root
(set `CLASH_BINARY=engine/target/release/clash` to include the end-to-end
tests). `npm run typecheck` and `npm run lint` check the TypeScript.

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
for how to build, test and propose a change, and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for how we work together.
Security problems: please report them privately, as described in
[`SECURITY.md`](SECURITY.md). Changes are listed in
[`CHANGELOG.md`](CHANGELOG.md).

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

The engine reads and meshes IFC with
[ifc-lite](https://crates.io/crates/ifc-lite-core). The test models come
from buildingSMART International (CC BY 4.0) and KIT; sources and terms are
in [`engine/tests/models/README.md`](engine/tests/models/README.md). All
dependency licences: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Licence

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
Copyright 2026 3dbyggeri danmark ApS.
