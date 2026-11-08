# The project file (`.clashproj`)

A Clash Tester project is one JSON file: which IFC files, which rules,
which settings. The desktop app saves and opens it, the CLI runs it, and
the headless MCP server keeps its state in one. It is meant to be
hand-editable. `clashtester init my-project.clashproj` writes a sample to
start from; `clashtester validate my-project.clashproj` checks one.

## Example

```json
{
  "version": 1,
  "name": "Example project",
  "createdAt": "2026-01-01T10:00:00Z",
  "files": [
    { "id": "arch", "path": "models/ARCH.ifc", "discipline": "ARCH" },
    { "id": "str",  "path": "models/STR.ifc",  "discipline": "STR" },
    { "id": "hvac", "path": "models/HVAC.ifc", "discipline": "HVAC",
      "translation": [0, 0, 0] }
  ],
  "rules": [
    { "name": "HVACxSTR", "preset": "HVACxSTR", "enabled": true },
    { "name": "Ducts vs beams",
      "preset": null,
      "a": { "fileId": "hvac", "selector": "IfcDuct*" },
      "b": { "fileId": "str",  "selector": "IfcBeam" } },
    { "name": "SELF-arch",
      "preset": null,
      "a": { "fileId": "arch", "selector": "*",
             "exclude": "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase" },
      "b": { "fileId": "arch", "selector": "*",
             "exclude": "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase" } }
  ],
  "settings": {
    "toleranceMeters": 0,
    "minPenetrationMeters": 0.005
  }
}
```

Runnable examples: [`examples/`](../examples).

## Top level

| Field | |
|---|---|
| `version` | Always `1`. |
| `name` | Free text, shown in reports. |
| `createdAt` | ISO-8601 string, informational. |
| `files` | The IFC files (at least one). |
| `rules` | The clash rules (may be empty). |
| `settings` | Optional, see [Settings](#settings). |
| `lastResults` | Written by the headless MCP server: when it last ran and where the outputs are. |

## Files

| Field | |
|---|---|
| `id` | Short, unique name the rules refer to. |
| `path` | Path to the IFC. Relative paths are resolved against the project file's folder. |
| `discipline` | Optional tag (`ARCH`, `STR`, `HVAC`, `MEP`, `ELEC`, `FIRE`, `GEO`). Presets match files by it. The desktop app and the MCP server guess it from the file name. |
| `translation` | Optional `[dx, dy, dz]` in metres, for a model that is offset from the others. See [How it works](HOW-IT-WORKS.md#coordinates-and-units). |

## Rules

A rule is either a **preset** reference or a **custom** rule. `enabled:
false` keeps it in the file but skips it.

**Preset rule** — `{ "name": …, "preset": "HVACxSTR" }`. The preset says
"these IFC types of discipline X against those of discipline Y"; every
file tagged X goes on side A and every file tagged Y on side B. If a side
has no file with its discipline, the rule is skipped with a
`rule_expansion` note. The thirteen shipped presets and their selectors:
[`presets/README.md`](../presets/README.md).

**Custom rule** — `"preset": null` and two sides `a` and `b`:

| Side field | |
|---|---|
| `fileId` | Required. One of the files' `id`. The same file on both sides is a **self check**. |
| `selector` | Which elements. Default `*` (all). |
| `mode` | `"i"` (default): elements matching the selector. `"e"`: everything **except** them. |
| `exclude` | Optional selector applied after `selector`/`mode`: matching elements are dropped. Must not be empty when present. |

## Selectors

| Selector | Matches |
|---|---|
| `IfcBeam` | exactly that class |
| `IfcDuct*` | every class starting with `IfcDuct` |
| `IfcWall\|IfcSlab` | any of the listed (each part may use `*`) |
| `*` | everything |
| `!IfcWall` | everything except (also with lists: `!IfcWall\|IfcSlab`) |
| `#2O2Fr$t4X7Zf8NOew3FLOH` | one element, by GUID |

Case is ignored (`IFCWALL` = `IfcWall`). A selector matches an element's
own class **or** its type class (next section).

## IFC2X3 type objects

In IFC2X3, ducts, pipes, fittings and terminals are generic occurrences —
`IfcFlowSegment`, `IfcFlowFitting`, `IfcFlowTerminal`,
`IfcFlowController`, … — and what they are sits on their type object.
Clash Tester reads `IfcRelDefinesByType`: a generic occurrence whose type
object's class ends in `Type` gets that class without `Type` as its
**type class** (`IfcDuctSegmentType` → `IfcDuctSegment`). So `IfcDuct*`
finds IFC2X3 ducts, and `IfcFlowSegment` still finds every flow segment.
This also works for IFC4 files that use generic occurrences.

`PredefinedType` (from the occurrence, else from its type object) is shown
but not matched. Generic occurrences without a type object — or with one
that is itself generic, like `IfcFlowSegmentType` — can't be classified;
each such file gets an `untyped_generic_mep` warning. Results
carry `typeClassA/B` and `predefinedTypeA/B`, and the desktop app shows
e.g. `IFCFLOWSEGMENT → IfcDuctSegment · RIGIDSEGMENT`.

## Settings

All optional.

| Setting | Default | |
|---|---|---|
| `toleranceMeters` | `0` | 0 = hard clashes. Above 0: report pairs closer than this (clearance). |
| `minPenetrationMeters` | `0.005` | Hard clashes must overlap at least this much. |
| `skipRelatedElements` | `true` | Skip pairs that belong together in the IFC ([details](HOW-IT-WORKS.md#related-elements)). |
| `bcfTopics` | `"clash"` | `"group"`: one BCF topic per group ([details](HOW-IT-WORKS.md#bcf-topics)). |
| `grouping.minElementClashes` | `2` | Pairs an element needs to lead a clash group. |
| `grouping.proximity` | off | `{ "enabled": true, "radiusMetres": 2 }` merges nearby groups into areas. |
| `grouping.duplicate` | `0.05` / `0.02` | `{ "maxVolumeDifference", "maxCentroidDistanceMetres" }` for double modelling, experimental ([details](HOW-IT-WORKS.md#double-modelling)). |
| `narrowPhase` | `"parry"` | `"ifclite"`: the experimental ifc-lite narrow phase ([details](HOW-IT-WORKS.md#ifc-lite-narrow-phase)). |
| `reportTouch` | `false` | ifc-lite only: also list touching and unconfirmed pairs. |

CLI options (`--bcf-topics`, `--narrow-phase`, `--no-relation-skip`)
override the project's settings for one run.
