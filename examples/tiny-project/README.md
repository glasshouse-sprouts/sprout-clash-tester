# tiny-project — minimal working example

A complete clash detection setup you can run in one command. Used for
end-to-end verification and as a starting point for first-time users.

## What's in it

- `sample.clashproj` — references the two small IFC files vendored with
  the Rust engine (`Building-Hvac.ifc` and `Building-Structural.ifc`).
- A single custom rule (`HVACxSTR`) covering everything in HVAC against
  everything in Structural at 100 mm clearance tolerance.

## How to run

From the repository root (after `cargo build --release` once):

```bash
node packages/cli/dist/index.js run examples/tiny-project/sample.clashproj
```

Or once the CLI is installed globally:

```bash
clashtester run examples/tiny-project/sample.clashproj
```

Outputs land in `examples/tiny-project/outputs/`:

```
report.bcf      — open in Model Viewer / BIMcollab / Solibri
clashes.json    — full structured run result (for agents / scripts)
clashes.csv     — one row per clash (spreadsheet-friendly)
```

## Why the paths are relative

`sample.clashproj` uses `../../engine/tests/models/...` so the file works
from a fresh clone without any local-machine assumptions. `loadProject`
resolves those paths against the `.clashproj`'s directory.

## Notes

- The CSV's `posX/posY/posZ` columns are in world metres.
- The engine prints WARNING: lines on stderr for misalignment-style issues
  (none expected with these well-coordinated test IFCs).

