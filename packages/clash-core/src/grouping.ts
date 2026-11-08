// Clash grouping — turns the flat clash list into groups, one group per
// future task-tracker topic. Pure data: no engine, no I/O, browser-safe.
//
// Design: SPEC.md §13a. Summary:
//   Level A (always) — clashes with the same unordered element pair merge.
//   Level B (always) — an element with >= `minElementClashes` pairs becomes
//                      a "hub"; all its pairs form one clash group.
//   Level C (opt-in) — groups with same-rule clash points within
//                      `radiusMetres` of each other merge into an area.
//   Duplicates       — same IFC type + (nearly) same volume + (nearly) same
//                      centre: split off first as "possible double
//                      modelling" (SPEC §13b) and kept out of levels B and C.
//
// Invariants (tested):
//   - every input clash lands in exactly one group;
//   - the result does not depend on input order (keys + membership).
//
// The levels live in ./grouping/; this file is the entry point and the
// public API (also the browser-safe `@clash-tester/core/grouping` path).

import type { ClashEntry } from "./types.js";
import { checkDuplicateOptions, isLikelyDuplicate } from "./grouping/duplicate.js";
import type { ClashGroup, ClashGroupKind, GroupingOptions } from "./grouping/groupTypes.js";
import { sortGroups } from "./grouping/helpers.js";
import {
  assignPairsToHubs,
  buildElementIndex,
  buildPairs,
  makeElementGroup,
  makePairGroup,
  type Pair,
} from "./grouping/pairs.js";
import { mergeByProximity } from "./grouping/proximity.js";

export {
  checkDuplicateOptions,
  DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES,
  DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE,
  duplicateVerdict,
  FLAT_DUPLICATE_AABB_MATCH,
  isLikelyDuplicate,
  normaliseIfcType,
  type DuplicateInput,
  type DuplicateOptions,
  type DuplicateVerdict,
} from "./grouping/duplicate.js";
export type {
  ClashGroup,
  ClashGroupKind,
  GroupElement,
  GroupingOptions,
  ProximityOptions,
} from "./grouping/groupTypes.js";
export { clashKey } from "./grouping/pairs.js";

export const DEFAULT_MIN_ELEMENT_CLASHES = 2;
export const DEFAULT_PROXIMITY_RADIUS_METRES = 2;

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Group clashes. See module header for the levels. Throws `RangeError` on
 * invalid options (callers validate project settings before this, so a
 * throw here means a programming error).
 */
export function groupClashes(
  clashes: readonly ClashEntry[],
  options: GroupingOptions = {},
): ClashGroup[] {
  const minElementClashes = options.minElementClashes ?? DEFAULT_MIN_ELEMENT_CLASHES;
  if (!Number.isInteger(minElementClashes) || minElementClashes < 2) {
    throw new RangeError("minElementClashes must be an integer >= 2");
  }
  const proximity = options.proximity;
  if (proximity?.enabled) {
    if (!Number.isFinite(proximity.radiusMetres) || proximity.radiusMetres <= 0) {
      throw new RangeError("proximity.radiusMetres must be a finite number > 0");
    }
  }
  const dupOptions = checkDuplicateOptions(options.duplicate);
  if (clashes.length === 0) return [];

  const allPairs = buildPairs(clashes);
  const elements = buildElementIndex(clashes);

  // Likely duplicates are split off first: they don't count towards hubs
  // (a wall modelled twice shouldn't turn into "wall clashes with 14
  // elements") and they never merge into areas.
  const isDupPair = (p: Pair): boolean =>
    p.indices.some((i) => isLikelyDuplicate(clashes[i]!, dupOptions));
  const dupPairs = allPairs.filter(isDupPair);
  const pairs = allPairs.filter((p) => !isDupPair(p));
  const assignment = assignPairsToHubs(pairs, minElementClashes);

  // Build A/B groups.
  const byHub = new Map<string, Pair[]>();
  const base: ClashGroup[] = [];
  for (const pair of pairs) {
    const hub = assignment.get(pair.key) ?? null;
    if (hub === null) {
      base.push(makePairGroup(pair, clashes, "pair"));
    } else {
      const list = byHub.get(hub);
      if (list) list.push(pair);
      else byHub.set(hub, [pair]);
    }
  }
  for (const [hub, hubPairs] of byHub) {
    base.push(makeElementGroup(hub, hubPairs, elements, clashes));
  }

  const merged =
    proximity?.enabled === true
      ? mergeByProximity(base, clashes, proximity.radiusMetres)
      : base;
  const duplicates = dupPairs.map((p) => makePairGroup(p, clashes, "duplicate"));

  // Duplicates first (they're a different kind of problem), then the rest.
  return [...sortGroups(duplicates), ...sortGroups(merged)];
}

/** Kind names in summaries (user-facing label = "Clash group"). */
const KIND_SUMMARY_LABEL: Record<ClashGroupKind, string> = {
  duplicate: "duplicate",
  clashGroup: "clash group",
  pair: "pair",
  area: "area",
};

/**
 * One-line summary used by the CLI and MCP, e.g.
 * `"12 groups (3 clash group, 8 pair, 1 area)"`. Zero-count kinds are left out.
 */
export function summariseGroups(groups: readonly ClashGroup[]): string {
  const counts: Record<ClashGroupKind, number> = { duplicate: 0, clashGroup: 0, pair: 0, area: 0 };
  for (const g of groups) counts[g.kind]++;
  const parts = (["duplicate", "clashGroup", "pair", "area"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${KIND_SUMMARY_LABEL[k]}`);
  const noun = groups.length === 1 ? "group" : "groups";
  return parts.length > 0
    ? `${groups.length} ${noun} (${parts.join(", ")})`
    : `${groups.length} ${noun}`;
}
