# How it works

How Clash Tester decides what is a clash, step by step, and what it writes.
The components are described in [`ARCHITECTURE.md`](ARCHITECTURE.md), the
project file in [`PROJECT-FILE.md`](PROJECT-FILE.md).

A run, in order:

1. Load each IFC file once: metadata, relations, then meshes in metres,
   with openings cut out of their hosts.
2. For each rule, select side A and side B (selectors, exclude,
   translation).
3. Check every A × B pair: bounding boxes first, then skip pairs that are
   the same element, already tested, or belong together in the IFC.
4. Decide hard clash / clearance / nothing on the meshes.
5. Number the clashes, group them, and write BCF, JSON and CSV, plus
   warnings.

## Coordinates and units

**Everything is in metres after load.** Each file's active length unit
(`IFCUNITASSIGNMENT`: mm, cm, dm, m, inch, foot; unknown counts as m)
converts its meshes once, in the loader. From there the engine works in
metres only: thresholds, depths, gaps, positions, cameras, bounding boxes,
volumes, translations. A mm file and a metre file clash correctly against
each other.

**Frame.** Clash points and BCF cameras are in the IFC world frame (Z-up,
metres, `IfcMapConversion` not applied).

**Translation.** A file may carry a translation `[dx, dy, dz]` in metres,
for a model that is offset from the others. It moves that file into the
others' frame, so clash points and cameras are in the frame of the
**untranslated** files. If every file of a rule is translated there is no
such frame, and the run warns `bcf_frame_translated`. Rotation is not
supported.

**Precision at survey coordinates.** Models placed at real survey
coordinates (millions of metres) would lose about half a metre if any step
went through 32-bit floats at that size. The loader asks ifc-lite for an
anchor near the model, which it subtracts in 64-bit before any 32-bit work
(opening cuts included), and a local origin per mesh; both are added back
in 64-bit: `world = (anchor + origin + position) × unit scale`. Tested: the
FZK-Haus sample moved to UTM coordinates gives the same opening cuts and
clashes as at the origin, positions within 0.001 mm. Faces that are
exactly flush (distance 0) are the exception: float noise of any size can
decide whether such surfaces "cross".

## Placement checks

Models that were exported with different origins don't clash at all, and
the run would silently report nothing. So:

- **Before detection** (`clash check-alignment`, run by the desktop app
  whenever the file list changes): each file's `IFCSITE` origin is read
  from the text, without meshing. Files more than 10 m apart are reported
  as separate placement groups (`placement_mismatch_quick`). Files where
  only some carry `IfcMapConversion`, or with different map conversions,
  get `mapconversion_split` — clash detection still works, but
  georeferencing viewers will place them apart.
- **After loading**, between files that meet in a rule, using each
  file's **whole-file bounding box** (every loaded element, after the
  file's translation — not only what a rule selects):
  `placement_mismatch` when the box centres split into more
  than one group (more than 0.5 m apart on every axis), and
  `no_aabb_overlap` when two files' bounding boxes don't touch at all.

## Opening cuts

Walls and slabs are meshed **with their openings cut out**
(`IfcRelVoidsElement`), using ifc-lite's own path: plane clipping for
rectangular openings, its CSG otherwise. Without this a door standing in
its opening is inside the wall's solid box. A host is only cut when some
rule side of the run selects it.

Cuts are never silently wrong. Every run reports one line, e.g.
`opening cuts: 9 hosts cut, 17 openings, 0 failed, 0 not cut`, and
warnings that name the elements:

- `opening_cut_failed` — the cut errored; the host keeps its **uncut**
  mesh, so clashes against it may be false.
- `opening_not_cut` — the cut ran but this opening removed nothing. After
  cutting, each opening is shrunk 1 mm and checked for host faces crossing
  it or lying inside it (assumes convex or star-shaped openings). The host
  keeps its cut mesh.
- `opening_cut_open_mesh` — ifc-lite returned a cut that isn't a closed
  mesh. It is kept as cut; this is a note, not a failure.

## Geometry that can't be read

An element whose 3D body can't be meshed would simply be missing from
every rule. So the loader counts each element that **has a body** — a
shape representation labelled `Body` (or `Facetation`, or with no label)
— but gives no usable mesh: meshing errors, fewer than three points, or
no triangles. Each file with such elements gets one warning,
`geometry_failed`, with the count and the first five as
`GUID (IFC type, reason)`; they are not checked.

Not counted, because they were never 3D geometry: elements without a
representation (e.g. an `IfcRoof` that only aggregates its parts) and
elements with only 2D or axis representations (`IfcAnnotation` plan
symbols, `IfcGrid` lines).

## Related elements

A door sits in an opening in its wall, the opening cuts the wall, and the
parts of an assembly touch each other. These pairs overlap by design, so
they are skipped:

| Relation | Pairs skipped |
|---|---|
| `IfcRelVoidsElement` (host, opening) | host × opening |
| `IfcRelFillsElement` (opening, filler) | opening × filler, and host × filler via the opening |
| `IfcRelAggregates` (whole, parts) | whole × part, part × part |

Relations only apply within one file. Each rule reports how many pairs it
skipped ("Skipped (belong together)"). Turn it off with
`settings.skipRelatedElements: false` or `--no-relation-skip`. With the
walls cut, a window frame that sits a little into its own reveal is one of
these pairs.

## Clash or not

- **Bounding boxes first.** Pairs whose boxes don't overlap are never
  tested further (in hard mode).
- **Hard clash** (default, tolerance 0): the overlap must be **at least**
  the minimum penetration, default 5 mm. Shallower overlaps are not
  reported.
- **Clearance** (`toleranceMeters` > 0): pairs closer than the tolerance
  are clashes; the gap is reported.
- **Depth is an estimate.** With the default narrow phase (parry) the
  reported depth is the smallest side of the bounding-box overlap, not the
  true penetration, and the overlap volume is the box overlap's volume.
  Gaps in clearance mode are real mesh distances. The ifc-lite phase
  (below) measures depth on the meshes where it can.

The desktop Results table shows depth or gap as "Severity": ↕ for an
overlap, ↔ for a clearance gap, ≈ for an estimated ifc-lite depth.

## Self check

A self check tests a model against itself: a rule with the same file on
both sides (desktop: Rules → Self check; `SELF-<fileId>`). Within such a
rule an element is never paired with itself, and each pair is tested once
(not A × B and B × A). The same GUID in two **different** files is still
reported — that is a real cross-model finding.

New self checks leave out `IfcSpace`, `IfcSpatialZone`, `IfcOpeningElement`
and `IfcOpeningStandardCase` on both sides: a space "clashes" with every
wall around it, which means nothing here.

## Double modelling

**Experimental** — the rule and its thresholds may still change. A clash
is flagged as **possible double modelling** when all three hold:

1. **Same IFC type** after normalising (`IfcWall` = `IFCWALLSTANDARDCASE`).
2. **Same place:** the two mesh centres are at most 2 cm apart.
3. **Same size:** the mesh volumes differ by at most 5 % of the larger.
   If both meshes are flat, their bounding boxes must match at least 95 %
   instead; one flat and one solid never match.

Thresholds: `settings.grouping.duplicate` in the project file. Volumes are
measured by splitting the mesh into tetrahedra from its vertex average and
summing their absolute volumes — independent of triangle winding, exact
for convex closed meshes and consistent otherwise. It works in every rule,
not only self checks (the same wall in two discipline models). The
desktop app shows, per clash, each criterion with its measured value and
limit.

Not caught: a copy shifted by more than 2 cm, a different length, or a
copy modelled as another type.

## Grouping

Raw clashes are noisy — one duct crossing twelve beams is twelve clashes.
Groups turn them into issues. Every clash lands in exactly one group, and
the result doesn't depend on input order.

| Kind | What |
|---|---|
| `duplicate` | Possible double modelling (one element pair). Listed first, never merged further — the fix is different (delete one). |
| `clashGroup` | One element clashing with at least 2 others (`minElementClashes`): all its pairs. |
| `pair` | One element pair, all rules that reported it. |
| `area` | Opt-in: groups whose same-rule clash points are within 2 m (`proximity.radiusMetres`), merged. |

When both elements of a pair could lead a clash group, the one with more
pairs wins (tie: the side-A element). A would-be clash group left with
fewer than the minimum falls back to pairs.

*Worked example:* clashes A–B, A–C, A–D and E–D. A is in 3 pairs, D in 2.
A–D goes to A (more pairs), which leaves D with one pair, so D is not a
clash group. Result: "A clashes with 3 elements" {A–B, A–C, A–D} and the
pair "D × E" {E–D}.

Group keys are stable between runs: `pair:<guid>|<guid>`,
`clashgroup:<guid>`, `duplicate:<guid>|<guid>`, `area:<smallest member
key>` (area keys are less stable, which is why areas are opt-in).
Settings: `settings.grouping` in the project file.

## BCF topics

**Numbering.** Every clash gets a number: its position in the run's list.
It is the BCF topic title prefix (`"3 - Clash between …"`), the first CSV
column `no`, `number` in the JSON and `#` in the desktop app. Numbers are
stable within one run only.

**One topic per clash** (default): the two elements are selected, and the
camera looks at the clash point from 5 m back and above.

**One topic per group** (`settings.bcfTopics: "group"`, `--bcf-topics
group`): title `"<n> - <group title>"` (`n` = the group's position,
as in the desktop Groups table), a description listing the member clashes,
all the group's elements selected, and a camera far enough back to fit
them.

**Frame.** Viewpoints are in the IFC world frame (see
[Coordinates and units](#coordinates-and-units)), so they line up with the
models as exported. All BCF is written by the engine; per-group topics go
through `clash bcf`.

## Outputs

| File | Content |
|---|---|
| `report.bcf` | BCF 2.1, one topic per clash or per group, placeholder snapshot. |
| `clashes.json` | The whole run: clashes (types, GUIDs, files, position, depth or gap, measurements), groups, per-rule counts, opening-cut line, warnings. |
| `clashes.csv` | One row per clash; columns added later go at the end, so existing positions don't move. |

**Where.** The CLI writes to `outputs/` next to the project file (`--out`
to change). The desktop app writes next to a saved project, or to a
temporary folder for an unsaved one (Show / Export in Results). The
headless MCP server writes next to its project file unless `output_dir`
is given.

## ifc-lite narrow phase

**Experimental.** The default narrow phase (parry) reports faces that merely touch as
clashes and aims each clash at the centre of the box overlap.
[ifc-lite-clash](https://crates.io/crates/ifc-lite-clash) instead
classifies each pair as hard / touch / clearance on the meshes, gives a
real contact point, and says whether its depth was measured or estimated
from the boxes.

Turn it on with `settings.narrowPhase: "ifclite"`, `--narrow-phase ifclite`
or the desktop checkbox "Use the ifc-lite narrow phase (trial)".
Everything else — selectors, translation, opening cuts, skips, grouping,
numbering, BCF — is shared.

| ifc-lite says | Result |
|---|---|
| Hard, depth measured, at least the minimum | clash |
| Hard, depth estimated, and the surfaces really cross | clash (`distanceKind: "estimate"`) |
| Hard, estimated, no crossing | not a clash — counted as *unconfirmed* |
| Touch (faces within 1 mm, or overlap under 1 mm) | not a clash — counted as *touch* |

Each rule reports its touch and unconfirmed counts; `settings.reportTouch`
also lists those pairs (status `touch` / `unconfirmed`). To keep 32-bit
precision, each rule's elements are passed to ifc-lite relative to a local
origin. `clashtester run --compare-narrow-phase <project>` runs both
phases and prints, per rule, what both or only one of them found.
