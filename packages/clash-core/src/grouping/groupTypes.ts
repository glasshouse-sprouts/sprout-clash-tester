// Public types of clash grouping (SPEC §13a).

import type { DuplicateOptions } from "./duplicate.js";

export interface ProximityOptions {
  /** Turn level C on. Default off. */
  enabled: boolean;
  /** Max distance in metres between two clash points to merge. Default 2. */
  radiusMetres: number;
}

export interface GroupingOptions {
  /**
   * Level B threshold: an element must clash with at least this many other
   * elements to become a hub. Integer >= 2. Default 2.
   */
  minElementClashes?: number;
  /** Level C. Omitted = off. */
  proximity?: ProximityOptions;
  /** Double-modelling thresholds (SPEC §13b). */
  duplicate?: DuplicateOptions;
}

/**
 * Kinds, in display order:
 *  - `duplicate` — same IFC type, same volume, same place: likely
 *    double modelling (see `DuplicateOptions`). Always a single pair; never merged into
 *    element hubs or areas, because it needs a different fix (delete one).
 *  - `clashGroup` — one element clashing with many (level B). Shown as
 *    "Clash group". Was `element` before 2026-10-29 (old results may
 *    still carry it).
 *  - `pair`      — one element pair (level A).
 *  - `area`      — nearby groups merged (level C, opt-in).
 */
export type ClashGroupKind = "duplicate" | "clashGroup" | "pair" | "area";

/** An IFC element as seen in the clash list. */
export interface GroupElement {
  guid: string;
  ifcType: string;
  /** Source file basename (may be empty). */
  file: string;
}

export interface ClashGroup {
  /**
   * Stable identifier — what a task-tracker topic is matched on.
   * `pair:<g1>|<g2>`, `clashgroup:<guid>`, or `area:<smallest member key>`.
   */
  key: string;
  kind: ClashGroupKind;
  /** Short human-readable title (usable as a topic title). */
  title: string;
  /** The hub element. Set for kind `clashGroup` only. */
  element: GroupElement | null;
  /** Indices into the clash array passed to `groupClashes`, ascending. */
  clashIndices: number[];
  /** Distinct clash keys (element pairs) in the group, sorted. */
  clashKeys: string[];
  /** `clashKeys.length` — number of distinct element pairs. */
  pairCount: number;
  /** Rules that fired inside the group, sorted. */
  rules: string[];
  /** Centroid of member clash positions, metres. */
  position: [number, number, number];
  /** Largest penetration depth among members (intersection mode), else null. */
  maxDepthMetres: number | null;
  /** Smallest clearance gap among members (clearance mode), else null. */
  minGapMetres: number | null;
  /** Sum of member AABB-overlap volumes in m³, null if none reported. */
  aabbOverlapVolume: number | null;
  /** For kind `area`: keys of the A/B groups that were merged, sorted. */
  memberGroupKeys?: string[];
}
