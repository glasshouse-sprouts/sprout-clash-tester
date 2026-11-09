# Desktop click-list

CI tests the engine, the TypeScript packages and what the desktop forms
send ([`CONTRIBUTING.md`](../CONTRIBUTING.md)), but not the desktop UI
itself. Before a release, or after a change to a view, run this list by
hand and note in the PR what you clicked.

Start the app with `npm run dev` in `packages/desktop`. The models are in
`engine/tests/models/`; drag them onto the window.

## 1. Files and rules

1. Drop `Building-Hvac.ifc` and `Building-Structural.ifc`. The Files view
   lists both with disciplines **HVAC** and **STR**; the placement panel
   says **"Placement check OK"**.
2. Rules → **Auto-add presets**: `HVACxSTR` appears as _preset_.
3. Rules → Self check: pick **`building-hvac`** in the file list (the
   first file, so it's chosen already), leave **"Ignore spaces, zones and
   openings"** ticked, click **Add self check**. The rule
   `SELF-building-hvac` shows as _self check_ with
   `not IfcSpace|IfcSpatialZo…` on both sides; the button now says
   **Already added**. Hover the detail for the full exclude list. Add only
   this one: a self check on `building-structural` adds 24 clashes of its
   own and the numbers in step 7 no longer match.
4. Click the pencil on the self check: the form shows both sides with the
   exclude filled in. **Cancel** closes it.
5. Add a custom rule with these fields, then **Add custom rule**:

   | Field             | Value                 |
   | ----------------- | --------------------- |
   | Name              | `HVAC all vs STR all` |
   | Side A — file     | `building-hvac`       |
   | Side A — selector | `*`                   |
   | Side B — file     | `building-structural` |
   | Side B — selector | `*`                   |

   The selector is only the IFC type (`*` = every type); the file is
   picked in its own field. A selector like `building-hvac *` matches no
   type and the rule finds nothing.

   The Rules view now has three rules: `HVACxSTR` (preset),
   `SELF-building-hvac` (self check) and `HVAC all vs STR all` (custom).

## 2. Run, numbers and groups

6. Set the tolerance to 0.1 m (project file `"toleranceMeters": 0.1`, or
   the desktop MCP's `ui_set_settings` — there is no field for it yet) and
   click **Run**.
7. Results: **6 clashes, 4 groups**. Per rule: `HVAC all vs STR all` 5,
   `SELF-building-hvac` 1, `HVACxSTR` 0. The Clashes table's `#` column runs
   1–6; **Export…** the BCF and check the topic titles start with the same
   numbers ("1 - Clash between …"), and the CSV's first column `no` too.
8. The amber callout **"Possible double modelling (2) · experimental"**
   is shown; the two proxy clashes carry a **double?** badge.
9. Click a **double?** row: the detail shows ✓ Same IFC type, ✓ Centre
   distance 0.0 cm, ✓ Same size 1.000 vs 1.000 m³. Click a duct × chimney
   row: ✗ on all three, with the measured values.
10. Click a row in the Groups table: the group and its clashes are
    highlighted.

## 3. BCF per group

11. Top bar → **BCF topics: per group**, **Run**, export the BCF. It has
    one topic per group (4), titled "1 - Possible double modelling: …",
    …, "3 - IFCCHIMNEY clashes with 3 elements …"; the clash-group topic
    selects all 4 of its elements.

## 4. Relation skip and opening cuts

12. Drop `AC20-FZK-Haus.ifc`; add a custom rule `IfcDoor` × `IfcWall*` on
    that file; set the tolerance back to 0 and **Run**.
13. Results header: **"Geometry: opening cuts: 8 hosts cut, 16 openings,
    0 failed, 0 not cut"**. Per rule: the doors × walls rule has **0**
    clashes and **5** in "Skipped (belong together)".
14. Rules → untick **"Skip elements that belong together in the IFC"**,
    **Run**: the doors × walls rule now has **5** clashes.

## 5. IFC2X3 type objects

15. Drop `ifc2x3-mep-types.ifc`; add a custom rule `IfcDuct*` × `IfcBeam`
    on that file; **Run**.
16. The rule has 2 clashes. Type A shows
    **`IFCFLOWSEGMENT → IfcDuctSegment · RIGIDSEGMENT`** and
    **`IFCFLOWFITTING → IfcDuctFitting · BEND`**. Warnings list
    **`untyped_generic_mep`** for the file's one segment without a type
    object.

## 6. Close

17. Close the window with unsaved changes: the **Save / Discard / Cancel**
    prompt appears.
