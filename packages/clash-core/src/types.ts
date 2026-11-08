// Shared TypeScript shapes for the clash-set JSON the engine accepts
// and the result shape the Node runner returns.
//
// These match the Rust engine's serde structs (see engine/src/lib.rs):
//   ClashSet, SelectionGroup, EngineWarning, DetectionResult
//
// Keep this in sync if the engine's serialised types change.

import type { ClashGroup, GroupingOptions } from "./grouping.js";
// Type-only re-export so browser code (desktop renderer) can use the group
// shape via the `@clash-tester/core/types` sub-path without bundling Node code.
export type { ClashGroup, ClashGroupKind, GroupElement, GroupingOptions } from "./grouping.js";
// Same for the project-file shapes. The desktop renderer imported these from
// this sub-path before they existed here, which silently made them `any`.
export type {
  Project,
  ProjectFile,
  ProjectRule,
  ProjectRuleCustom,
  ProjectRulePreset,
  ProjectRuleSide,
  ProjectSettings,
  ProjectLastResults,
  AutoAddPresetsResult,
} from "./project.js";

/**
 * Exclude used by self checks by default: spaces, spatial zones and opening elements
 * (IFC2x3 + IFC4 `IfcOpeningStandardCase`) and spatial zones only produce
 * meaningless internal clashes. docs/HOW-IT-WORKS.md#self-check. Lives here (not project.ts) so
 * the browser-safe `@clash-tester/core/types` sub-path can export it.
 */
export const SELF_CHECK_DEFAULT_EXCLUDE =
  "IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase";

/** One side (A or B) of a clash rule — a file + selector. */
export interface SelectionGroup {
  /** Absolute path to an .ifc file on disk. */
  file: string;
  /**
   * IFC type selector. Supported syntax:
   * - exact: `IfcBeam`
   * - wildcard: `IfcDuct*`
   * - pipe list: `IfcWall|IfcSlab`
   * - negation: `!IfcWall`
   * - everything: `*`
   */
  selector?: string;
  /** `"i"` = include (default) or `"e"` = exclude. */
  mode?: "i" | "e";
  /**
   * Optional selector (same syntax as `selector`) applied AFTER the
   * include step — matching elements are dropped. Self checks use
   * `SELF_CHECK_DEFAULT_EXCLUDE` to skip spaces and openings (docs/HOW-IT-WORKS.md#self-check).
   */
  exclude?: string;
  /**
   * Per-file translation override in **metres** (world units).
   * Default `[0, 0, 0]` = no translation. Only the user supplies this
   * for edge cases where IFCs don't share a coordinate origin.
   * See docs/HOW-IT-WORKS.md#coordinates-and-units.
   */
  translation?: [number, number, number];
}

/** One named clash rule: elements on side A tested against side B. */
export interface ClashRule {
  /** Stable name, e.g. `"MEPxSTR"`. Surfaced in reports. */
  name: string;
  a: SelectionGroup[];
  b: SelectionGroup[];
}

/** Structured warning emitted by the engine. */
export interface EngineWarning {
  /** Machine-readable identifier — currently only `"no_aabb_overlap"`. */
  kind: string;
  /** Human-readable text. */
  message: string;
  /** Basenames of the files involved. */
  files: string[];
}

/** Per-rule clash count. */
export interface RuleCount {
  name: string;
  clashes: number;
  /**
   * Overlapping element pairs skipped because they belong together by IFC
   * relations (opening in its host, door/window in its wall, parts of an
   * assembly) — docs/HOW-IT-WORKS.md#related-elements. Absent from older engines.
   */
  skippedByRelations?: number;
  /**
   * ifc-lite narrow phase (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase): pairs whose faces only
   * touch, and hard-by-box-estimate pairs parry could not confirm — not clashes.
   * Absent with the parry narrow phase / older engines.
   */
  touchCount?: number;
  unconfirmedCount?: number;
}

/**
 * Openings (IfcRelVoidsElement) cut out of their host elements in a run —
 * docs/HOW-IT-WORKS.md#opening-cuts. A host whose cut failed keeps its uncut mesh; its GUID is in
 * `failed` (engine warning `opening_cut_failed`). An opening that removed
 * nothing from its host is in `notCut` (warning `opening_not_cut`). A
 * host that was cut but whose cut mesh is not closed (ifc-lite's
 * open-topology note) is in `hostsCut` and `openMesh` (warning
 * `opening_cut_open_mesh`); absent in older results.
 */
export interface OpeningCuts {
  hostsCut: number;
  openings: number;
  failed: string[];
  notCut: string[];
  openMesh?: string[];
}

/** The one-line report every run shows, e.g.
 * `opening cuts: 12 hosts cut, 30 openings, 0 failed, 0 not cut`. */
export function formatOpeningCuts(c: OpeningCuts): string {
  return (
    `opening cuts: ${c.hostsCut} hosts cut, ${c.openings} openings, ` +
    `${c.failed.length} failed, ${c.notCut.length} not cut` +
    (c.openMesh?.length ? `, ${c.openMesh.length} with open mesh` : "")
  );
}

/** `" (not clashes: 3 touching, 1 unconfirmed)"` for an ifc-lite rule
 * with such pairs, else `""` (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase). */
export function formatNotClashes(r: RuleCount): string {
  return r.touchCount || r.unconfirmedCount
    ? ` (not clashes: ${r.touchCount ?? 0} touching, ${r.unconfirmedCount ?? 0} unconfirmed)`
    : "";
}

/** A single clash, broken down for downstream consumers (CSV, agents). */
export interface ClashEntry {
  /**
   * 1-based position in the run's clash list — the number the BCF topic
   * title starts with (`"1 - Clash between …"`) and the CSV `no` column.
   * Stable within one run only, not across runs. Absent in results
   * written before it existed; use array index + 1 then.
   */
  number?: number;
  /** Rule that fired. Empty when the legacy `--file` engine path is used. */
  rule: string;
  ifcTypeA: string;
  ifcTypeB: string;
  guidA: string;
  guidB: string;
  /** Source file basename for element A. Empty if the engine couldn't track it. */
  fileA: string;
  /** Source file basename for element B. */
  fileB: string;
  /** World position of the clash midpoint in metres. */
  position: [number, number, number];
  /** Detection mode that fired the clash. */
  mode: "intersection" | "clearance" | "";
  /**
   * Approximate penetration depth in metres. Set only in intersection
   * mode. **Caveat:** this is the AABB-overlap minimum dimension
   * (proxy), not true geometric depth. Monotonic with truth.
   */
  depthMetres: number | null;
  /**
   * Clearance gap in metres. Set only in clearance mode.
   * This one IS real-world accurate (parry's min mesh distance).
   */
  gapMetres: number | null;
  /**
   * Extents `[dx, dy, dz]` of the AABB-overlap box in metres.
   * `null` when the AABBs don't overlap (only possible in clearance mode).
   */
  aabbOverlapExtents: [number, number, number] | null;
  /**
   * Volume of the AABB-overlap box in m³ (= dx · dy · dz).
   * Bounding-box volume, **not** true geometric overlap volume.
   * Useful as a crude severity proxy.
   */
  aabbOverlapVolume: number | null;
  /**
   * How alike the two elements' bounding boxes are, 0..1 (1 = identical).
   * Per axis: overlap length / longer length; the smallest of the three.
   * Informational only — double modelling is decided by type + volume +
   * centre (see `isLikelyDuplicate`). `null` when the boxes don't
   * overlap; absent in results from older engines.
   */
  aabbMatch?: number | null;
  /** Mesh volume of element A in m³. `null` for flat meshes. */
  volumeA?: number | null;
  /** Mesh volume of element B in m³. `null` for flat meshes. */
  volumeB?: number | null;
  /** Distance between the two elements' mesh centres, metres. */
  centroidDistanceMetres?: number | null;
  /**
   * ifc-lite narrow phase only (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase): `hard` / `clearance`,
   * or — listed only with `reportTouch` — `touch` / `unconfirmed`.
   */
  status?: "hard" | "clearance" | "touch" | "unconfirmed";
  /** ifc-lite only: depth/gap measured on the meshes or read off the boxes. */
  distanceKind?: "mesh" | "estimate";
  /**
   * Class read off element A's / B's type object when the occurrence is
   * a generic IFC2X3-style one (`IFCFLOWSEGMENT` typed as a duct segment
   * → `IfcDuctSegment`), docs/PROJECT-FILE.md#ifc2x3-type-objects. Absent when the occurrence class
   * says it.
   */
  typeClassA?: string;
  typeClassB?: string;
  /** `PredefinedType` of element A / B (occurrence, else type object). */
  predefinedTypeA?: string;
  predefinedTypeB?: string;
}

/** `"IFCFLOWSEGMENT → IfcDuctSegment"` when the type object says more
 * than the occurrence class, else the occurrence class (docs/PROJECT-FILE.md#ifc2x3-type-objects).
 * */
export function formatIfcClass(ifcType: string, typeClass?: string): string {
  return typeClass ? `${ifcType} → ${typeClass}` : ifcType;
}

/** What the Node runner returns to its caller. */
export interface RunResult {
  /** Did the engine binary exit cleanly (code 0)? */
  ok: boolean;
  /** Raw exit code from the engine process. */
  exitCode: number;
  /** Total clashes reported by the engine. */
  totalClashes: number;
  /** Clashes broken down per rule name. */
  perRule: RuleCount[];
  /**
   * All individual clashes the engine reported. The CSV writer iterates
   * this list; agents/JSON consumers also get full per-clash data here.
   */
  clashes: ClashEntry[];
  /**
   * Clashes grouped into future task-tracker topics (docs/HOW-IT-WORKS.md#grouping).
   * Always set by `run()`; optional only so results saved by older
   * versions (without groups) still type-check when read back.
   */
  groups?: ClashGroup[];
  /** Warnings the engine emitted (e.g. misalignment hints). */
  warnings: EngineWarning[];
  /** Openings cut out of their hosts (docs/HOW-IT-WORKS.md#opening-cuts). Absent from older
   * engines. */
  openingCuts?: OpeningCuts;
  /** Where outputs landed. `bcf` is set when an output BCF was requested. */
  outputs: {
    bcf?: string;
    summary: string;
  };
  /** stdout from the engine (kept for debugging — may be large). */
  stdout: string;
  /** stderr from the engine. */
  stderr: string;
}

/** Per-file alignment input for `checkAlignment()`. */
export interface AlignmentFileInput {
  /** Absolute path to an `.ifc` file. */
  file: string;
  /**
   * Optional per-file translation in metres `[dx, dy, dz]`. Applied to
   * the IFCSITE origin before clustering. Default `[0, 0, 0]`.
   */
  translation?: [number, number, number];
}

/** Per-file alignment result. */
export interface AlignmentFileResult {
  path: string;
  /** IFCSITE origin in metres as read from the file. */
  origin: [number, number, number];
  /** `origin + translation` in metres. */
  effectiveOrigin: [number, number, number];
  /** Cluster label this file belongs to (A, B, …). */
  cluster: string;
  /** Length unit reported by the file ("millimetre", "metre", …). */
  lengthUnit: string;
  /**
   * IfcMapConversion data (eastings/northings/orthogonalHeight) when
   * the file has one. Present-vs-absent across the federation is what
   * fires the `mapconversion_split` info-level warning.
   */
  mapConversion: {
    eastings: number;
    northings: number;
    orthogonalHeight: number;
  } | null;
}

/** One cluster identified by the alignment check. */
export interface AlignmentCluster {
  label: string;
  centre: [number, number, number];
  files: string[];
}

/** Result of `checkAlignment()`. */
export interface AlignmentResult {
  ok: boolean;
  exitCode: number;
  files: AlignmentFileResult[];
  clusters: AlignmentCluster[];
  warnings: EngineWarning[];
  stderr: string;
}

/** Options accepted by `run()`. */
export interface RunOptions {
  /** The clash rules to evaluate. */
  rules: ClashRule[];
  /**
   * Optional path to write the BCF report. When omitted, no BCF is written
   * but the run still produces clash counts and warnings.
   */
  outputBcf?: string;
  /**
   * BCF topics: `"clash"` (default) = one topic per clash, written by the
   * engine during detection; `"group"` = one topic per clash group, built
   * with `groupsToTopics` and written by `clash bcf` afterwards (docs/HOW-IT-WORKS.md#bcf-topics).
   */
  bcfTopics?: "clash" | "group";
  /**
   * Skip element pairs that belong together by IFC relations
   * (docs/HOW-IT-WORKS.md#related-elements). Default true; `false` passes `--no-relation-skip` to
   * the engine.
   */
  skipRelatedElements?: boolean;
  /** Narrow phase (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase). Default `"parry"`. */
  narrowPhase?: "parry" | "ifclite";
  /** ifc-lite only: list touching / unconfirmed pairs too. Default false. */
  reportTouch?: boolean;
  /**
   * Clearance tolerance in metres. Elements closer than this distance count
   * as clashes (clearance mode). Default `0` = hard-intersection mode.
   */
  toleranceMeters?: number;
  /**
   * Minimum penetration in metres in hard-intersection mode. Default `0.005`
   * (5 mm). Ignored when `toleranceMeters > 0`.
   */
  minPenetrationMeters?: number;
  /**
   * Absolute path to the `clash` binary. When omitted, the runner uses
   * `CLASH_BINARY` env var, then falls back to `engine/target/release/clash`
   * relative to the workspace root.
   */
  enginePath?: string;
  /**
   * Working directory for temp files (clash-set JSON, summary). Defaults
   * to the OS temp directory.
   */
  workDir?: string;
  /**
   * Optional streaming callback. Fires once per stdout line the engine
   * emits while detection is in progress. Useful for live progress
   * indicators in front-ends. The full output is still collected and
   * returned on `RunResult.stdout` regardless.
   */
  onProgress?: (line: string) => void;
  /**
   * Grouping options (docs/HOW-IT-WORKS.md#grouping). Levels A + B always run; level C
   * (proximity) only when `grouping.proximity.enabled`.
   */
  grouping?: GroupingOptions;
}
