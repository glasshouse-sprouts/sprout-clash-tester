# Changelog

All notable changes to Clash Tester are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is 0.x, minor versions may contain breaking changes.

## [Unreleased]

First public release in preparation. Everything below is what it will
contain.

### Added

- **Three ways to run:** the `clashtester` CLI (`init`, `validate`, `run`),
  an Electron desktop app (Files, Rules and Results views), and a headless
  MCP server for AI agents.
- **Rules:** thirteen discipline presets (e.g. `HVACxSTR`), custom rules
  with IFC type selectors (`IfcDuct*`, `IfcWall|IfcSlab`, `!IfcSpace`) and
  an optional per-side `exclude`, and self checks (a model against
  itself).
- **Project files** (`.clashproj`): files with discipline tags and
  optional translation, rules and settings; relative paths resolve
  against the project file.
- **Engine:** clash detection in metres whatever the files' units, full
  precision at survey coordinates, hard clashes (minimum penetration,
  default 5 mm) or clearance.
- **Opening cuts:** walls and slabs are meshed with their openings cut
  out; every run reports what was cut and warns about cuts that failed or
  removed nothing.
- **Related elements skipped:** opening in host, door or window in its
  wall, parts of an assembly (can be turned off).
- **IFC2X3 MEP:** generic flow elements are classified by their type
  object, so `IfcDuct*` finds IFC2X3 ducts.
- **Possible double modelling** (experimental): same type, same place, same size —
  flagged and grouped separately, with a per-criterion breakdown in the
  desktop app.
- **Grouping:** clashes grouped into issues (element pairs, one element
  against many, double modelling, optional nearby areas).
- **Outputs:** BCF 2.1 (one topic per clash or per group), `clashes.json`
  and `clashes.csv`; every clash numbered the same way in all three.
- **Unreadable geometry is reported:** an element with a 3D body that
  can't be meshed gets a `geometry_failed` warning naming it, instead of
  silently dropping out of the check.
- **Placement checks:** warnings when models don't share a placement,
  before detection (from `IFCSITE`, plus `IfcMapConversion` mismatches)
  and after it.
- **Desktop MCP server** (`clash-tester-ui`): an agent can see the open
  project, results and selection, run detection and edit the project,
  with a visible one-step Undo for every edit.
- **Experimental ifc-lite narrow phase** (`--narrow-phase ifclite`):
  separates touching faces from real clashes and gives real contact
  points; `--compare-narrow-phase` compares it with the default.
- **Docs:** architecture, how detection works, the project file format,
  MCP setup.

### Fixed

- The placement checks after loading compare whole-file bounding boxes.
  They used the elements a rule selects, so two well-aligned models
  could get a false "fix the alignment" warning (e.g. the HVAC-vs-
  structure preset, where the ducts and the beams sit in different parts
  of the building).

### Security

- The desktop app runs on Electron 45, with the renderer sandboxed; the
  window can't navigate away or open new windows, and browser permission
  requests are denied.
- The headless MCP server only uses project files (`.clashproj`, `.json`)
  for `project_path`, and `get_results` only returns Clash Tester result
  files.
