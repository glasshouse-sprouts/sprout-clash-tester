// Small helpers shared by the grouping levels.

import type { ClashEntry } from "../types.js";
import type { ClashGroup } from "./groupTypes.js";

type Aggregates = Pick<
  ClashGroup,
  "position" | "maxDepthMetres" | "minGapMetres" | "aabbOverlapVolume"
>;

export function aggregate(members: readonly ClashEntry[]): Aggregates {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let maxDepth: number | null = null;
  let minGap: number | null = null;
  let volume: number | null = null;
  for (const c of members) {
    sx += c.position[0];
    sy += c.position[1];
    sz += c.position[2];
    if (c.depthMetres !== null) maxDepth = Math.max(maxDepth ?? -Infinity, c.depthMetres);
    if (c.gapMetres !== null) minGap = Math.min(minGap ?? Infinity, c.gapMetres);
    if (c.aabbOverlapVolume !== null) volume = (volume ?? 0) + c.aabbOverlapVolume;
  }
  const n = members.length || 1;
  return {
    position: [sx / n, sy / n, sz / n],
    maxDepthMetres: maxDepth,
    minGapMetres: minGap,
    aabbOverlapVolume: volume,
  };
}

/** Biggest groups first (by element pairs, then clashes), then by key. */
export function sortGroups(groups: ClashGroup[]): ClashGroup[] {
  return [...groups].sort(
    (x, y) =>
      y.pairCount - x.pairCount ||
      y.clashIndices.length - x.clashIndices.length ||
      cmp(x.key, y.key),
  );
}

export function sortByKey(groups: ClashGroup[]): ClashGroup[] {
  return [...groups].sort((x, y) => cmp(x.key, y.key));
}

export function rulesSuffix(rules: string[]): string {
  const named = rules.filter((r) => r.length > 0);
  return named.length > 0 ? ` [${named.join(", ")}]` : "";
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function dist2(a: readonly number[], b: readonly number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return dx * dx + dy * dy + dz * dz;
}
