// Level C (opt-in): groups with nearby same-rule clash points merge into
// an area.

import type { ClashEntry } from "../types.js";
import type { ClashGroup } from "./groupTypes.js";
import { aggregate, dist2, rulesSuffix, sortByKey, uniqueSorted } from "./helpers.js";

// ─── Level C: proximity ──────────────────────────────────────────────────────

/**
 * Single-linkage merge: two groups join when they have clash points from
 * the same rule within `radius` metres. Uses a uniform grid (cell = radius)
 * so only neighbouring cells are compared.
 */
export function mergeByProximity(
  base: ClashGroup[],
  clashes: readonly ClashEntry[],
  radius: number,
): ClashGroup[] {
  // Deterministic order before union-find.
  const groups = sortByKey(base);
  const groupOf = new Map<number, number>(); // clash index → group index
  groups.forEach((g, gi) => g.clashIndices.forEach((ci) => groupOf.set(ci, gi)));

  const parent = groups.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const cellOf = (p: readonly number[]): [number, number, number] => [
    Math.floor(p[0]! / radius),
    Math.floor(p[1]! / radius),
    Math.floor(p[2]! / radius),
  ];
  const grid = new Map<string, number[]>(); // "rule|cx,cy,cz" → clash indices
  for (const ci of groupOf.keys()) {
    const c = clashes[ci]!;
    const [x, y, z] = cellOf(c.position);
    const k = `${c.rule}|${x},${y},${z}`;
    const list = grid.get(k);
    if (list) list.push(ci);
    else grid.set(k, [ci]);
  }
  const r2 = radius * radius;
  for (const ci of groupOf.keys()) {
    const c = clashes[ci]!;
    const [x, y, z] = cellOf(c.position);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const near = grid.get(`${c.rule}|${x + dx},${y + dy},${z + dz}`);
          if (!near) continue;
          for (const cj of near) {
            if (cj <= ci) continue;
            const gi = groupOf.get(ci)!;
            const gj = groupOf.get(cj)!;
            if (find(gi) === find(gj)) continue;
            if (dist2(c.position, clashes[cj]!.position) <= r2) union(gi, gj);
          }
        }
      }
    }
  }

  const components = new Map<number, number[]>();
  groups.forEach((_, gi) => {
    const root = find(gi);
    const list = components.get(root);
    if (list) list.push(gi);
    else components.set(root, [gi]);
  });

  const out: ClashGroup[] = [];
  for (const memberIdx of components.values()) {
    if (memberIdx.length === 1) {
      out.push(groups[memberIdx[0]!]!);
      continue;
    }
    const members = memberIdx.map((i) => groups[i]!);
    const indices = members.flatMap((g) => g.clashIndices).sort((x, y) => x - y);
    const memberClashes = indices.map((i) => clashes[i]!);
    const memberGroupKeys = uniqueSorted(members.map((g) => g.key));
    const clashKeys = uniqueSorted(members.flatMap((g) => g.clashKeys));
    const rules = uniqueSorted(memberClashes.map((c) => c.rule));
    out.push({
      key: `area:${memberGroupKeys[0]!}`,
      kind: "area",
      title: `Area with ${members.length} clash groups, ${clashKeys.length} element pairs${rulesSuffix(rules)}`,
      element: null,
      clashIndices: indices,
      clashKeys,
      pairCount: clashKeys.length,
      rules,
      ...aggregate(memberClashes),
      memberGroupKeys,
    });
  }
  return out;
}
