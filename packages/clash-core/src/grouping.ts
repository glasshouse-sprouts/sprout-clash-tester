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

import type { ClashEntry } from "./types.js";

// ─── Public types ────────────────────────────────────────────────────────────

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
 * When is a clash "possible double modelling"? All of:
 *  1. same IFC type (IfcWall = IfcWallStandardCase, etc.);
 *  2. mesh centres at most `maxCentroidDistanceMetres` apart;
 *  3. mesh volumes differ by at most `maxVolumeDifference` (relative to
 *     the larger). If BOTH meshes are flat (no volume), their bounding
 *     boxes must match >= 95 % instead. One flat + one solid ⇒ never.
 */
export interface DuplicateOptions {
  /** 0..1. Default 0.05 (5 %). */
  maxVolumeDifference?: number;
  /** Metres, >= 0. Default 0.02 (2 cm). */
  maxCentroidDistanceMetres?: number;
}

export const DEFAULT_MIN_ELEMENT_CLASHES = 2;
export const DEFAULT_PROXIMITY_RADIUS_METRES = 2;
export const DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE = 0.05;
export const DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES = 0.02;
/** Box-match fallback used only when both meshes are flat. */
export const FLAT_DUPLICATE_AABB_MATCH = 0.95;

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

/**
 * IFC type with the `…StandardCase` / `…ElementedCase` suffix removed and
 * upper-cased, so IfcWall and IFCWALLSTANDARDCASE compare equal.
 */
export function normaliseIfcType(t: string): string {
  return t.toUpperCase().replace(/(STANDARDCASE|ELEMENTEDCASE)$/, "");
}

/** Validate duplicate options; throws `RangeError` when out of range. */
export function checkDuplicateOptions(o: DuplicateOptions = {}): Required<DuplicateOptions> {
  const maxVolumeDifference = o.maxVolumeDifference ?? DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE;
  const maxCentroidDistanceMetres =
    o.maxCentroidDistanceMetres ?? DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES;
  if (!Number.isFinite(maxVolumeDifference) || maxVolumeDifference < 0 || maxVolumeDifference > 1) {
    throw new RangeError("duplicate.maxVolumeDifference must be between 0 and 1");
  }
  if (!Number.isFinite(maxCentroidDistanceMetres) || maxCentroidDistanceMetres < 0) {
    throw new RangeError("duplicate.maxCentroidDistanceMetres must be a number >= 0");
  }
  return { maxVolumeDifference, maxCentroidDistanceMetres };
}

/** The clash fields the double-modelling decision looks at. */
export type DuplicateInput = Pick<
  ClashEntry,
  "ifcTypeA" | "ifcTypeB" | "aabbMatch" | "volumeA" | "volumeB" | "centroidDistanceMetres"
>;

/**
 * Why a clash is / isn't "possible double modelling", criterion by
 * criterion (TASKS T5). `likelyDuplicate` is true only when all three
 * criteria pass.
 */
export interface DuplicateVerdict {
  likelyDuplicate: boolean;
  /** Thresholds the verdict was made against. */
  thresholds: Required<DuplicateOptions>;
  /** 1. Same IFC type after `normaliseIfcType`. */
  sameType: { ok: boolean; typeA: string; typeB: string };
  /** 2. Mesh centres close enough. `distanceMetres` null when not reported. */
  centre: { ok: boolean; distanceMetres: number | null };
  /**
   * 3. Same size. `method`:
   *  - `"volume"`: both meshes have a volume; compares `volumeDifference`
   *    (relative to the larger) with `maxVolumeDifference`;
   *  - `"flatBoxes"`: both meshes flat; compares `aabbMatch` with
   *    `FLAT_DUPLICATE_AABB_MATCH`;
   *  - `"mixed"`: one flat, one solid — never the same thing.
   */
  size: {
    ok: boolean;
    method: "volume" | "flatBoxes" | "mixed";
    volumeA: number | null;
    volumeB: number | null;
    volumeDifference: number | null;
    aabbMatch: number | null;
  };
}

/** Per-criterion double-modelling breakdown — see `DuplicateOptions`. */
export function duplicateVerdict(c: DuplicateInput, options: DuplicateOptions = {}): DuplicateVerdict {
  const thresholds = checkDuplicateOptions(options);

  const sameType =
    !!c.ifcTypeA && normaliseIfcType(c.ifcTypeA) === normaliseIfcType(c.ifcTypeB);

  const d = typeof c.centroidDistanceMetres === "number" ? c.centroidDistanceMetres : null;
  const centreOk = d !== null && d <= thresholds.maxCentroidDistanceMetres;

  const va = c.volumeA ?? null;
  const vb = c.volumeB ?? null;
  const aabbMatch = typeof c.aabbMatch === "number" ? c.aabbMatch : null;
  let size: DuplicateVerdict["size"];
  if (va !== null && vb !== null && va > 0 && vb > 0) {
    const diff = Math.abs(va - vb) / Math.max(va, vb);
    size = {
      ok: diff <= thresholds.maxVolumeDifference,
      method: "volume",
      volumeA: va,
      volumeB: vb,
      volumeDifference: diff,
      aabbMatch,
    };
  } else if (va === null && vb === null) {
    // Both flat (e.g. surfaces): fall back to near-identical boxes.
    size = {
      ok: aabbMatch !== null && aabbMatch >= FLAT_DUPLICATE_AABB_MATCH,
      method: "flatBoxes",
      volumeA: null,
      volumeB: null,
      volumeDifference: null,
      aabbMatch,
    };
  } else {
    size = { ok: false, method: "mixed", volumeA: va, volumeB: vb, volumeDifference: null, aabbMatch };
  }

  return {
    likelyDuplicate: sameType && centreOk && size.ok,
    thresholds,
    sameType: { ok: sameType, typeA: c.ifcTypeA, typeB: c.ifcTypeB },
    centre: { ok: centreOk, distanceMetres: d },
    size,
  };
}

/** True when a clash looks like double modelling — see `DuplicateOptions`. */
export function isLikelyDuplicate(c: DuplicateInput, options: DuplicateOptions = {}): boolean {
  return duplicateVerdict(c, options).likelyDuplicate;
}

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

// ─── Clash key ───────────────────────────────────────────────────────────────

/**
 * Stable key for one clash: the unordered element pair. Independent of rule
 * and of which side each element was on. Clashes without GUIDs (legacy
 * engine path) fall back to rule + position rounded to the millimetre.
 */
export function clashKey(c: Pick<ClashEntry, "guidA" | "guidB" | "rule" | "position">): string {
  if (c.guidA && c.guidB) {
    return c.guidA <= c.guidB ? `${c.guidA}|${c.guidB}` : `${c.guidB}|${c.guidA}`;
  }
  const p = c.position.map((v) => (Math.round(v * 1000) / 1000).toFixed(3)).join(",");
  return `${c.rule}@${p}`;
}

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

// ─── Level A: element pairs ──────────────────────────────────────────────────

interface Pair {
  key: string;
  /** Member clash indices, ascending. */
  indices: number[];
  /** The two element GUIDs, side-A element first. Null without GUIDs. */
  ends: [string, string] | null;
}

function buildPairs(clashes: readonly ClashEntry[]): Pair[] {
  const map = new Map<string, number[]>();
  clashes.forEach((c, i) => {
    const k = clashKey(c);
    const list = map.get(k);
    if (list) list.push(i);
    else map.set(k, [i]);
  });
  const pairs: Pair[] = [];
  for (const [key, indices] of map) {
    // Representative clash: smallest rule name, then smallest guidA.
    // Order-independent, so "which end is side A" is deterministic even
    // when two rules report the same pair with swapped sides.
    const rep = indices
      .map((i) => clashes[i]!)
      .sort((x, y) => cmp(x.rule, y.rule) || cmp(x.guidA, y.guidA))[0]!;
    const ends: [string, string] | null =
      rep.guidA && rep.guidB ? [rep.guidA, rep.guidB] : null;
    pairs.push({ key, indices, ends });
  }
  pairs.sort((x, y) => cmp(x.key, y.key));
  return pairs;
}

function buildElementIndex(clashes: readonly ClashEntry[]): Map<string, GroupElement> {
  const map = new Map<string, GroupElement>();
  for (const c of clashes) {
    if (c.guidA && !map.has(c.guidA)) {
      map.set(c.guidA, { guid: c.guidA, ifcType: c.ifcTypeA, file: c.fileA });
    }
    if (c.guidB && !map.has(c.guidB)) {
      map.set(c.guidB, { guid: c.guidB, ifcType: c.ifcTypeB, file: c.fileB });
    }
  }
  return map;
}

// ─── Level B: element hubs ───────────────────────────────────────────────────

/**
 * Returns pairKey → hub GUID (or null = stays a pair group).
 *
 * 1. Degree = number of distinct pairs an element is in.
 * 2. Hubs = elements with degree >= min.
 * 3. Each pair goes to its best hub end: higher degree, then the side-A
 *    element, then the lower GUID.
 * 4. Hubs that end up with fewer than `min` pairs are demoted; repeat
 *    until stable. The hub set only shrinks, so this terminates.
 */
function assignPairsToHubs(pairs: Pair[], min: number): Map<string, string | null> {
  const degree = new Map<string, number>();
  for (const p of pairs) {
    if (!p.ends) continue;
    const [a, b] = p.ends;
    degree.set(a, (degree.get(a) ?? 0) + 1);
    if (b !== a) degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const hubs = new Set<string>();
  for (const [guid, d] of degree) if (d >= min) hubs.add(guid);

  for (;;) {
    const assignment = new Map<string, string | null>();
    const counts = new Map<string, number>();
    for (const p of pairs) {
      let chosen: string | null = null;
      if (p.ends) {
        const [a, b] = p.ends;
        const aHub = hubs.has(a);
        const bHub = hubs.has(b);
        if (aHub && bHub) {
          const da = degree.get(a) ?? 0;
          const db = degree.get(b) ?? 0;
          // Higher degree wins; on a tie the side-A element (`a`) wins.
          chosen = db > da ? b : a;
        } else if (aHub) {
          chosen = a;
        } else if (bHub) {
          chosen = b;
        }
      }
      assignment.set(p.key, chosen);
      if (chosen !== null) counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
    }
    const demote = [...hubs].filter((h) => (counts.get(h) ?? 0) < min);
    if (demote.length === 0) return assignment;
    for (const h of demote) hubs.delete(h);
  }
}

// ─── Group construction ──────────────────────────────────────────────────────

function makePairGroup(
  pair: Pair,
  clashes: readonly ClashEntry[],
  kind: "pair" | "duplicate",
): ClashGroup {
  const indices = [...pair.indices].sort((x, y) => x - y);
  const members = indices.map((i) => clashes[i]!);
  // Title from the side-A orientation of the representative pair.
  const first = members.find((c) => pair.ends && c.guidA === pair.ends[0]) ?? members[0]!;
  const rules = uniqueSorted(members.map((c) => c.rule));
  const typeA = first.guidA === pair.ends?.[0] ? first.ifcTypeA : first.ifcTypeB;
  const typeB = first.guidA === pair.ends?.[0] ? first.ifcTypeB : first.ifcTypeA;
  const prefix = kind === "duplicate" ? "Possible double modelling: " : "";
  return {
    key: `${kind}:${pair.key}`,
    kind,
    title: `${prefix}${typeA || "?"} × ${typeB || "?"}${rulesSuffix(rules)}`,
    element: null,
    clashIndices: indices,
    clashKeys: [pair.key],
    pairCount: 1,
    rules,
    ...aggregate(members),
  };
}

function makeElementGroup(
  hub: string,
  hubPairs: Pair[],
  elements: Map<string, GroupElement>,
  clashes: readonly ClashEntry[],
): ClashGroup {
  const indices = hubPairs.flatMap((p) => p.indices).sort((x, y) => x - y);
  const members = indices.map((i) => clashes[i]!);
  const rules = uniqueSorted(members.map((c) => c.rule));
  const element = elements.get(hub) ?? { guid: hub, ifcType: "", file: "" };

  // Count the other ends' IFC types, once per pair.
  const otherTypes = new Map<string, number>();
  for (const p of hubPairs) {
    const other = p.ends ? (p.ends[0] === hub ? p.ends[1] : p.ends[0]) : "";
    const t = elements.get(other)?.ifcType || "?";
    otherTypes.set(t, (otherTypes.get(t) ?? 0) + 1);
  }
  const typeSummary = [...otherTypes]
    .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
    .map(([t, n]) => `${t} ×${n}`)
    .join(", ");

  return {
    key: `clashgroup:${hub}`,
    kind: "clashGroup",
    title: `${element.ifcType || "?"} clashes with ${hubPairs.length} elements (${typeSummary})${rulesSuffix(rules)}`,
    element,
    clashIndices: indices,
    clashKeys: uniqueSorted(hubPairs.map((p) => p.key)),
    pairCount: hubPairs.length,
    rules,
    ...aggregate(members),
  };
}

// ─── Level C: proximity ──────────────────────────────────────────────────────

/**
 * Single-linkage merge: two groups join when they have clash points from
 * the same rule within `radius` metres. Uses a uniform grid (cell = radius)
 * so only neighbouring cells are compared.
 */
function mergeByProximity(
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Aggregates = Pick<
  ClashGroup,
  "position" | "maxDepthMetres" | "minGapMetres" | "aabbOverlapVolume"
>;

function aggregate(members: readonly ClashEntry[]): Aggregates {
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
function sortGroups(groups: ClashGroup[]): ClashGroup[] {
  return [...groups].sort(
    (x, y) =>
      y.pairCount - x.pairCount ||
      y.clashIndices.length - x.clashIndices.length ||
      cmp(x.key, y.key),
  );
}

function sortByKey(groups: ClashGroup[]): ClashGroup[] {
  return [...groups].sort((x, y) => cmp(x.key, y.key));
}

function rulesSuffix(rules: string[]): string {
  const named = rules.filter((r) => r.length > 0);
  return named.length > 0 ? ` [${named.join(", ")}]` : "";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dist2(a: readonly number[], b: readonly number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return dx * dx + dy * dy + dz * dz;
}
