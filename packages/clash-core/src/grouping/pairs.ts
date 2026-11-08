// Levels A and B: clashes merged per element pair, and element hubs (one
// element clashing with many) — plus building their groups.

import type { ClashEntry } from "../types.js";
import type { ClashGroup, GroupElement } from "./groupTypes.js";
import { aggregate, cmp, rulesSuffix, uniqueSorted } from "./helpers.js";

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

// ─── Level A: element pairs ──────────────────────────────────────────────────

export interface Pair {
  key: string;
  /** Member clash indices, ascending. */
  indices: number[];
  /** The two element GUIDs, side-A element first. Null without GUIDs. */
  ends: [string, string] | null;
}

export function buildPairs(clashes: readonly ClashEntry[]): Pair[] {
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

export function buildElementIndex(clashes: readonly ClashEntry[]): Map<string, GroupElement> {
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
export function assignPairsToHubs(pairs: Pair[], min: number): Map<string, string | null> {
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

export function makePairGroup(
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

export function makeElementGroup(
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
