// Tests for clash grouping (SPEC §13a). Pure data — no engine.

import { describe, expect, it } from "vitest";
import {
  clashKey,
  duplicateVerdict,
  groupClashes,
  isLikelyDuplicate,
  normaliseIfcType,
  summariseGroups,
  type ClashGroup,
} from "./grouping.js";
import type { ClashEntry } from "./types.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  D: "IfcDuctSegment",
  P: "IfcPipeSegment",
  B: "IfcBeam",
  C: "IfcColumn",
  W: "IfcWall",
};

/** Clash between element GUIDs a and b; IFC type taken from the GUID's first letter. */
function clash(
  a: string,
  b: string,
  opts: Partial<ClashEntry> & { at?: [number, number, number] } = {},
): ClashEntry {
  const { at, ...rest } = opts;
  return {
    rule: "HVACxSTR",
    ifcTypeA: TYPES[a[0]!] ?? "IfcBuildingElementProxy",
    ifcTypeB: TYPES[b[0]!] ?? "IfcBuildingElementProxy",
    guidA: a,
    guidB: b,
    fileA: "A.ifc",
    fileB: "B.ifc",
    position: at ?? [0, 0, 0],
    mode: "intersection",
    depthMetres: 0.01,
    gapMetres: null,
    aabbOverlapExtents: [0.01, 0.01, 0.01],
    aabbOverlapVolume: 0.000001,
    ...rest,
  };
}

/** Order-independent view of a grouping: key → sorted clash identities. */
function signature(groups: ClashGroup[], clashes: ClashEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    out[g.key] = g.clashIndices
      .map((i) => {
        const c = clashes[i]!;
        return `${c.rule}:${c.guidA}>${c.guidB}`;
      })
      .sort();
  }
  return out;
}

/** Every clash index appears exactly once across all groups. */
function expectPartition(groups: ClashGroup[], n: number): void {
  const seen = groups.flatMap((g) => g.clashIndices).sort((x, y) => x - y);
  expect(seen).toEqual(Array.from({ length: n }, (_, i) => i));
}

/** Small deterministic PRNG so "random" tests are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ─── clashKey ────────────────────────────────────────────────────────────────

describe("clashKey", () => {
  it("is independent of side order", () => {
    expect(clashKey(clash("D1", "B1"))).toBe(clashKey(clash("B1", "D1")));
    expect(clashKey(clash("D1", "B1"))).toBe("B1|D1");
  });

  it("is independent of the rule", () => {
    expect(clashKey(clash("P1", "W1", { rule: "MEPxARCH" }))).toBe(
      clashKey(clash("P1", "W1", { rule: "FIRExARCH" })),
    );
  });

  it("falls back to rule + mm-rounded position without GUIDs", () => {
    const k = clashKey(clash("", "", { at: [1.00049, 2, -3.2] }));
    expect(k).toBe("HVACxSTR@1.000,2.000,-3.200");
  });
});

// ─── Level A ─────────────────────────────────────────────────────────────────

describe("groupClashes — level A (element pairs)", () => {
  it("returns no groups for no clashes", () => {
    expect(groupClashes([])).toEqual([]);
  });

  it("one clash → one pair group", () => {
    const cs = [clash("D1", "B1")];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.kind).toBe("pair");
    expect(gs[0]!.key).toBe("pair:B1|D1");
    expect(gs[0]!.title).toBe("IfcDuctSegment × IfcBeam [HVACxSTR]");
    expect(gs[0]!.pairCount).toBe(1);
  });

  it("merges the same pair reported by two rules (any side order)", () => {
    const cs = [
      clash("P1", "W1", { rule: "MEPxARCH" }),
      clash("W1", "P1", { rule: "FIRExARCH" }),
    ];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.clashIndices).toEqual([0, 1]);
    expect(gs[0]!.rules).toEqual(["FIRExARCH", "MEPxARCH"]);
    expect(gs[0]!.pairCount).toBe(1);
    expectPartition(gs, cs.length);
  });

  it("keeps unrelated pairs apart", () => {
    const cs = [clash("D1", "B1"), clash("D2", "B2")];
    const gs = groupClashes(cs);
    expect(gs.map((g) => g.key).sort()).toEqual(["pair:B1|D1", "pair:B2|D2"]);
  });

  it("clashes without GUIDs stay as separate pair groups", () => {
    const cs = [clash("", "", { at: [0, 0, 0] }), clash("", "", { at: [5, 0, 0] })];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(2);
    expectPartition(gs, 2);
  });
});

// ─── Level B ─────────────────────────────────────────────────────────────────

describe("groupClashes — level B (one element, many clashes)", () => {
  it("one duct crossing three beams → one element group about the duct", () => {
    const cs = [clash("D1", "B1"), clash("D1", "B2"), clash("D1", "B3")];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(1);
    const g = gs[0]!;
    expect(g.kind).toBe("clashGroup");
    expect(g.key).toBe("clashgroup:D1");
    expect(g.element).toEqual({ guid: "D1", ifcType: "IfcDuctSegment", file: "A.ifc" });
    expect(g.pairCount).toBe(3);
    expect(g.title).toBe("IfcDuctSegment clashes with 3 elements (IfcBeam ×3) [HVACxSTR]");
  });

  it("SPEC §13a worked example: A–B, A–C, A–D, E–D", () => {
    // Degrees A=3, D=2 → hubs A and D. A–D goes to A (more pairs). D keeps
    // only E–D (< 2) → demoted to a pair. D appears in both groups; each
    // clash is in exactly one.
    const cs = [clash("A", "B"), clash("A", "C"), clash("A", "D"), clash("E", "D")];
    const gs = groupClashes(cs);
    expect(gs.map((g) => [g.kind, g.key])).toEqual([
      ["clashGroup", "clashgroup:A"],
      ["pair", "pair:D|E"],
    ]);
    expect(gs[0]!.clashIndices).toEqual([0, 1, 2]);
    expect(gs[0]!.title).toMatch(/clashes with 3 elements/);
    expect(gs[1]!.clashIndices).toEqual([3]);
    expectPartition(gs, cs.length);
    expect(summariseGroups(gs)).toBe("2 groups (1 clash group, 1 pair)");
  });

  it("summarises mixed other-end types, most frequent first", () => {
    const cs = [clash("D1", "B1"), clash("D1", "C1"), clash("D1", "B2")];
    expect(groupClashes(cs)[0]!.title).toContain("(IfcBeam ×2, IfcColumn ×1)");
  });

  it("respects minElementClashes", () => {
    const cs = [clash("D1", "B1"), clash("D1", "B2"), clash("D1", "B3")];
    const gs = groupClashes(cs, { minElementClashes: 4 });
    expect(gs.every((g) => g.kind === "pair")).toBe(true);
    expect(gs).toHaveLength(3);
  });

  it("a beam hit by several pipes groups on the beam (hub can be on side B)", () => {
    const cs = [clash("P1", "B1"), clash("P2", "B1")];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.key).toBe("clashgroup:B1");
  });

  it("when both ends are hubs, the element with more pairs wins", () => {
    // D1: B1,B2 (2 pairs). B1: D1,P1,P2 (3 pairs). Pair D1–B1 goes to B1.
    const cs = [clash("D1", "B1"), clash("D1", "B2"), clash("P1", "B1"), clash("P2", "B1")];
    const gs = groupClashes(cs);
    const keys = gs.map((g) => g.key).sort();
    // D1 keeps only D1–B2 → below minimum → demoted to a pair group.
    expect(keys).toEqual(["clashgroup:B1", "pair:B2|D1"]);
    const b1 = gs.find((g) => g.key === "clashgroup:B1")!;
    expect(b1.pairCount).toBe(3);
    expectPartition(gs, cs.length);
  });

  it("on a tie, the side-A element wins", () => {
    // D1: B1,B2. B1: D1,D2. Both degree 2. D1–B1 → D1 (side A).
    // Then B1 keeps only D2–B1 → demoted.
    const cs = [clash("D1", "B1"), clash("D1", "B2"), clash("D2", "B1")];
    const gs = groupClashes(cs);
    expect(gs.map((g) => g.key).sort()).toEqual(["clashgroup:D1", "pair:B1|D2"]);
  });

  it("two independent hubs both form element groups", () => {
    const cs = [
      clash("D1", "B1"),
      clash("D1", "B2"),
      clash("D2", "B3"),
      clash("D2", "B4"),
      clash("D3", "B5"),
    ];
    const gs = groupClashes(cs);
    expect(gs.map((g) => g.key).sort()).toEqual(["clashgroup:D1", "clashgroup:D2", "pair:B5|D3"]);
  });
});

// ─── Aggregates + ordering ───────────────────────────────────────────────────

describe("groupClashes — aggregates and ordering", () => {
  it("computes centroid, max depth, summed AABB volume", () => {
    const cs = [
      clash("D1", "B1", { at: [0, 0, 0], depthMetres: 0.02, aabbOverlapVolume: 0.5 }),
      clash("D1", "B2", { at: [2, 4, 6], depthMetres: 0.07, aabbOverlapVolume: 0.25 }),
    ];
    const g = groupClashes(cs)[0]!;
    expect(g.position).toEqual([1, 2, 3]);
    expect(g.maxDepthMetres).toBe(0.07);
    expect(g.aabbOverlapVolume).toBe(0.75);
    expect(g.minGapMetres).toBeNull();
  });

  it("computes min gap in clearance mode", () => {
    const base = { mode: "clearance" as const, depthMetres: null, aabbOverlapVolume: null };
    const cs = [
      clash("D1", "B1", { ...base, gapMetres: 0.04 }),
      clash("D1", "B2", { ...base, gapMetres: 0.01 }),
    ];
    const g = groupClashes(cs)[0]!;
    expect(g.minGapMetres).toBe(0.01);
    expect(g.maxDepthMetres).toBeNull();
    expect(g.aabbOverlapVolume).toBeNull();
  });

  it("sorts biggest groups first", () => {
    const cs = [
      clash("D9", "B9"),
      clash("D1", "B1"),
      clash("D1", "B2"),
      clash("D1", "B3"),
    ];
    expect(groupClashes(cs)[0]!.key).toBe("clashgroup:D1");
  });
});

// ─── Level C ─────────────────────────────────────────────────────────────────

describe("groupClashes — level C (proximity, optional)", () => {
  const near = [
    clash("D1", "B1", { at: [0, 0, 0] }),
    clash("D2", "B2", { at: [1, 0, 0] }),
  ];

  it("is off by default", () => {
    expect(groupClashes(near).every((g) => g.kind !== "area")).toBe(true);
    expect(groupClashes(near)).toHaveLength(2);
  });

  it("merges same-rule groups within the radius into an area", () => {
    const gs = groupClashes(near, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(1);
    const g = gs[0]!;
    expect(g.kind).toBe("area");
    expect(g.key).toBe("area:pair:B1|D1");
    expect(g.memberGroupKeys).toEqual(["pair:B1|D1", "pair:B2|D2"]);
    expect(g.pairCount).toBe(2);
    expectPartition(gs, near.length);
  });

  it("does not merge beyond the radius", () => {
    const far = [clash("D1", "B1", { at: [0, 0, 0] }), clash("D2", "B2", { at: [5, 0, 0] })];
    const gs = groupClashes(far, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(2);
  });

  it("does not merge different rules at the same spot", () => {
    const mixed = [
      clash("D1", "B1", { at: [0, 0, 0], rule: "HVACxSTR" }),
      clash("P1", "W1", { at: [0.5, 0, 0], rule: "MEPxARCH" }),
    ];
    const gs = groupClashes(mixed, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(2);
  });

  it("chains (single-linkage) across grid cells", () => {
    const chain = [
      clash("D1", "B1", { at: [0, 0, 0] }),
      clash("D2", "B2", { at: [1.9, 0, 0] }),
      clash("D3", "B3", { at: [3.8, 0, 0] }),
    ];
    const gs = groupClashes(chain, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(1);
    expect(gs[0]!.memberGroupKeys).toHaveLength(3);
  });

  it("works at survey-coordinate magnitudes", () => {
    const survey = [
      clash("D1", "B1", { at: [6_675_000.0, 25_000_000.0, 40.0] }),
      clash("D2", "B2", { at: [6_675_001.0, 25_000_000.5, 40.0] }),
    ];
    const gs = groupClashes(survey, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(1);
  });

  it("can merge element groups too", () => {
    const cs = [
      clash("D1", "B1", { at: [0, 0, 0] }),
      clash("D1", "B2", { at: [0, 1, 0] }),
      clash("D2", "B3", { at: [0, 2.5, 0] }),
    ];
    const gs = groupClashes(cs, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs).toHaveLength(1);
    expect(gs[0]!.memberGroupKeys).toEqual(["clashgroup:D1", "pair:B3|D2"]);
  });
});

// ─── Duplicates (double modelling, SPEC §13b) ────────────────────────────────

/** Measurements of a perfect copy: same volume, same centre. */
const COPY = { volumeA: 2.4, volumeB: 2.4, centroidDistanceMetres: 0, aabbMatch: 1 };

describe("normaliseIfcType", () => {
  it("treats StandardCase / ElementedCase as the base type, any case", () => {
    expect(normaliseIfcType("IFCWALLSTANDARDCASE")).toBe("IFCWALL");
    expect(normaliseIfcType("IfcWall")).toBe("IFCWALL");
    expect(normaliseIfcType("IfcSlabElementedCase")).toBe("IFCSLAB");
    expect(normaliseIfcType("IfcBeam")).toBe("IFCBEAM");
  });
});

describe("isLikelyDuplicate — same type + volume + centre", () => {
  const base = {
    ifcTypeA: "IfcWall",
    ifcTypeB: "IFCWALLSTANDARDCASE",
    ...COPY,
  };

  it("flags an exact copy (types equal after normalising)", () => {
    expect(isLikelyDuplicate(base)).toBe(true);
  });

  it("never flags different IFC types — even with identical geometry", () => {
    expect(isLikelyDuplicate({ ...base, ifcTypeB: "IfcSlab" })).toBe(false);
    expect(isLikelyDuplicate({ ...base, ifcTypeA: "IfcStair", ifcTypeB: "IfcStairFlight" })).toBe(
      false,
    );
  });

  it("respects the 5 % volume limit", () => {
    expect(isLikelyDuplicate({ ...base, volumeA: 2.4, volumeB: 2.3 })).toBe(true); // 4.2 %
    expect(isLikelyDuplicate({ ...base, volumeA: 2.4, volumeB: 2.2 })).toBe(false); // 8.3 %
  });

  it("respects the 2 cm centre limit", () => {
    expect(isLikelyDuplicate({ ...base, centroidDistanceMetres: 0.019 })).toBe(true);
    expect(isLikelyDuplicate({ ...base, centroidDistanceMetres: 0.05 })).toBe(false);
  });

  it("ignores aabbMatch when volumes are known (old rule's false positive)", () => {
    // Same box, very different volume (e.g. solid column vs thin cladding shell).
    expect(isLikelyDuplicate({ ...base, volumeB: 0.3, aabbMatch: 1 })).toBe(false);
  });

  it("needs measurements — missing centre distance ⇒ not a duplicate", () => {
    expect(isLikelyDuplicate({ ...base, centroidDistanceMetres: null })).toBe(false);
    expect(isLikelyDuplicate({ ifcTypeA: "IfcWall", ifcTypeB: "IfcWall", aabbMatch: 1 })).toBe(
      false,
    );
  });

  it("flat meshes fall back to near-identical boxes; flat vs solid never matches", () => {
    const flat = { ...base, volumeA: null, volumeB: null };
    expect(isLikelyDuplicate({ ...flat, aabbMatch: 0.97 })).toBe(true);
    expect(isLikelyDuplicate({ ...flat, aabbMatch: 0.9 })).toBe(false);
    expect(isLikelyDuplicate({ ...base, volumeB: null })).toBe(false);
  });

  it("thresholds are configurable and validated", () => {
    const off = { ...base, volumeB: 2.0, centroidDistanceMetres: 0.04 };
    expect(isLikelyDuplicate(off)).toBe(false);
    expect(
      isLikelyDuplicate(off, { maxVolumeDifference: 0.2, maxCentroidDistanceMetres: 0.05 }),
    ).toBe(true);
    expect(() => isLikelyDuplicate(base, { maxVolumeDifference: 2 })).toThrow(RangeError);
    expect(() => isLikelyDuplicate(base, { maxCentroidDistanceMetres: -1 })).toThrow(RangeError);
  });
});

describe("duplicateVerdict — per-criterion breakdown (T5)", () => {
  const base = { ifcTypeA: "IfcWall", ifcTypeB: "IFCWALLSTANDARDCASE", ...COPY };

  it("all three criteria pass for an exact copy", () => {
    const v = duplicateVerdict(base);
    expect(v.likelyDuplicate).toBe(true);
    expect(v.sameType).toEqual({ ok: true, typeA: "IfcWall", typeB: "IFCWALLSTANDARDCASE" });
    expect(v.centre).toEqual({ ok: true, distanceMetres: 0 });
    expect(v.size).toMatchObject({ ok: true, method: "volume", volumeDifference: 0 });
    expect(v.thresholds).toEqual({ maxVolumeDifference: 0.05, maxCentroidDistanceMetres: 0.02 });
  });

  it("shows which criterion fails, and keeps evaluating the others", () => {
    const v = duplicateVerdict({ ...base, ifcTypeB: "IfcSlab", volumeB: 2.2, centroidDistanceMetres: 0.01 });
    expect(v.likelyDuplicate).toBe(false);
    expect(v.sameType.ok).toBe(false);
    expect(v.centre.ok).toBe(true);
    expect(v.size.ok).toBe(false);
    expect(v.size.volumeDifference).toBeCloseTo(0.2 / 2.4);
  });

  it("reports a missing centre distance as null + failed", () => {
    expect(duplicateVerdict({ ...base, centroidDistanceMetres: null }).centre).toEqual({
      ok: false,
      distanceMetres: null,
    });
  });

  it("names the size method: flat boxes and flat-vs-solid", () => {
    const flat = duplicateVerdict({ ...base, volumeA: null, volumeB: null, aabbMatch: 0.97 });
    expect(flat.size).toMatchObject({ ok: true, method: "flatBoxes", aabbMatch: 0.97 });
    const mixed = duplicateVerdict({ ...base, volumeB: null });
    expect(mixed.size).toMatchObject({ ok: false, method: "mixed", volumeA: 2.4, volumeB: null });
  });

  it("uses the thresholds given, and agrees with isLikelyDuplicate", () => {
    const off = { ...base, volumeB: 2.0, centroidDistanceMetres: 0.04 };
    const opts = { maxVolumeDifference: 0.2, maxCentroidDistanceMetres: 0.05 };
    expect(duplicateVerdict(off, opts).thresholds).toEqual(opts);
    for (const c of [base, off, { ...base, ifcTypeB: "IfcSlab" }, { ...base, volumeB: null }]) {
      expect(duplicateVerdict(c).likelyDuplicate).toBe(isLikelyDuplicate(c));
      expect(duplicateVerdict(c, opts).likelyDuplicate).toBe(isLikelyDuplicate(c, opts));
    }
  });
});

describe("groupClashes — likely duplicates", () => {
  it("a copy becomes its own 'duplicate' group", () => {
    const cs = [clash("W1", "W2", { ...COPY, rule: "SELF-ARK" })];
    const gs = groupClashes(cs);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.kind).toBe("duplicate");
    expect(gs[0]!.key).toBe("duplicate:W1|W2");
    expect(gs[0]!.title).toBe("Possible double modelling: IfcWall × IfcWall [SELF-ARK]");
  });

  it("different types in the same box stay normal clashes", () => {
    const cs = [clash("W1", "B1", { ...COPY })];
    expect(groupClashes(cs)[0]!.kind).toBe("pair");
  });

  it("duplicates don't feed element hubs", () => {
    // W1 duplicates W2 and also touches B1. Without the duplicate split,
    // W1 would be a hub (2 pairs). With it, W1–B1 stays a plain pair.
    const cs = [clash("W1", "W2", { ...COPY }), clash("W1", "B1")];
    const gs = groupClashes(cs);
    expect(gs.map((g) => g.key)).toEqual(["duplicate:W1|W2", "pair:B1|W1"]);
    expectPartition(gs, cs.length);
  });

  it("duplicates are listed first and never merged into areas", () => {
    const cs = [
      clash("D1", "B1", { at: [0, 0, 0] }),
      clash("D2", "B2", { at: [0.5, 0, 0] }),
      clash("W1", "W2", { at: [0.2, 0, 0], ...COPY }),
    ];
    const gs = groupClashes(cs, { proximity: { enabled: true, radiusMetres: 2 } });
    expect(gs[0]!.kind).toBe("duplicate");
    expect(gs[1]!.kind).toBe("area");
    expect(gs[1]!.memberGroupKeys).toEqual(["pair:B1|D1", "pair:B2|D2"]);
    expectPartition(gs, cs.length);
  });

  it("grouping passes duplicate thresholds through and validates them", () => {
    const cs = [clash("W1", "W2", { ...COPY, volumeB: 2.0 })]; // 16.7 % off
    expect(groupClashes(cs)[0]!.kind).toBe("pair");
    expect(groupClashes(cs, { duplicate: { maxVolumeDifference: 0.2 } })[0]!.kind).toBe(
      "duplicate",
    );
    expect(() => groupClashes(cs, { duplicate: { maxVolumeDifference: 1.5 } })).toThrow(
      RangeError,
    );
  });

  it("summary line counts duplicates first", () => {
    const cs = [clash("W1", "W2", { ...COPY }), clash("D1", "B1")];
    expect(summariseGroups(groupClashes(cs))).toBe("2 groups (1 duplicate, 1 pair)");
  });
});

// ─── Summary line ────────────────────────────────────────────────────────────

describe("summariseGroups", () => {
  it("counts kinds and skips zero counts", () => {
    const cs = [clash("D1", "B1"), clash("D1", "B2"), clash("D5", "B5")];
    expect(summariseGroups(groupClashes(cs))).toBe("2 groups (1 clash group, 1 pair)");
  });

  it("handles none and singular", () => {
    expect(summariseGroups([])).toBe("0 groups");
    expect(summariseGroups(groupClashes([clash("D1", "B1")]))).toBe("1 group (1 pair)");
  });
});

// ─── Options validation ──────────────────────────────────────────────────────

describe("groupClashes — option validation", () => {
  it("rejects minElementClashes < 2 or non-integer", () => {
    expect(() => groupClashes([], { minElementClashes: 1 })).toThrow(RangeError);
    expect(() => groupClashes([], { minElementClashes: 2.5 })).toThrow(RangeError);
  });

  it("rejects a non-positive radius when proximity is enabled", () => {
    expect(() =>
      groupClashes([], { proximity: { enabled: true, radiusMetres: 0 } }),
    ).toThrow(RangeError);
  });

  it("ignores the radius when proximity is disabled", () => {
    expect(() =>
      groupClashes([], { proximity: { enabled: false, radiusMetres: -1 } }),
    ).not.toThrow();
  });
});

// ─── Invariants on randomised data ───────────────────────────────────────────

describe("groupClashes — invariants (randomised, seeded)", () => {
  function randomClashes(seed: number, n: number): ClashEntry[] {
    const rand = rng(seed);
    const rules = ["HVACxSTR", "MEPxSTR", "MEPxARCH"];
    const out: ClashEntry[] = [];
    for (let i = 0; i < n; i++) {
      const a = `D${Math.floor(rand() * 15)}`;
      const b = `B${Math.floor(rand() * 15)}`;
      out.push(
        clash(a, b, {
          rule: rules[Math.floor(rand() * rules.length)]!,
          at: [rand() * 20, rand() * 20, rand() * 6],
        }),
      );
    }
    return out;
  }

  for (const seed of [1, 7, 42, 1234]) {
    for (const proximity of [false, true]) {
      it(`seed ${seed}, proximity ${proximity}: partition + order independence`, () => {
        const opts = proximity ? { proximity: { enabled: true, radiusMetres: 2 } } : {};
        const cs = randomClashes(seed, 80);
        const gs = groupClashes(cs, opts);
        expectPartition(gs, cs.length);

        // Same clashes in a different order → same keys and membership.
        const shuffled = shuffle(cs, rng(seed + 99));
        const gs2 = groupClashes(shuffled, opts);
        expect(signature(gs2, shuffled)).toEqual(signature(gs, cs));

        // Every element group meets the minimum.
        for (const g of gs) {
          if (g.kind === "clashGroup") expect(g.pairCount).toBeGreaterThanOrEqual(2);
          expect(g.pairCount).toBe(g.clashKeys.length);
        }
      });
    }
  }
});
