// Tests for group → BCF topic mapping (docs/HOW-IT-WORKS.md#bcf-topics). Pure data — no engine.

import { describe, expect, it } from "vitest";
import { cameraDistance, groupToTopic, groupsToTopics } from "./bcfTopics.js";
import { groupClashes } from "./grouping.js";
import type { ClashEntry } from "./types.js";

function clash(
  number: number,
  a: string,
  b: string,
  at: [number, number, number],
  typeA = "IfcDuctSegment",
  typeB = "IfcBeam",
): ClashEntry {
  return {
    number,
    rule: "HVACxSTR",
    ifcTypeA: typeA,
    ifcTypeB: typeB,
    guidA: a,
    guidB: b,
    fileA: "HVAC.ifc",
    fileB: "STR.ifc",
    position: at,
    mode: "intersection",
    depthMetres: 0.02,
    gapMetres: null,
    aabbOverlapExtents: [0.02, 0.1, 0.1],
    aabbOverlapVolume: 0.0002,
  };
}

// One beam hit by three ducts (an `element` group) + one lone pair.
const CLASHES: ClashEntry[] = [
  clash(1, "D1", "B1", [0, 0, 3]),
  clash(2, "D2", "B1", [4, 0, 3]),
  clash(3, "D3", "B1", [8, 0, 3]),
  clash(4, "D9", "B9", [50, 50, 3]),
];

function groups() {
  return groupClashes(CLASHES);
}

describe("groupToTopic", () => {
  it("numbers the title with the group's list position", () => {
    const g = groups()[0]!;
    expect(groupToTopic(g, 7, CLASHES).title).toBe(`7 - ${g.title}`);
  });

  it("selects every distinct element of the group, in order of appearance", () => {
    const hub = groups().find((g) => g.kind === "clashGroup")!;
    expect(groupToTopic(hub, 1, CLASHES).guids).toEqual(["D1", "B1", "D2", "D3"]);
  });

  it("describes the kind and lists each member clash with its number", () => {
    const hub = groups().find((g) => g.kind === "clashGroup")!;
    const lines = groupToTopic(hub, 1, CLASHES).description.split("\n");
    expect(lines[0]).toBe("Clash group (one element, many clashes) — 3 clashes, 3 element pairs");
    expect(lines.slice(1)).toEqual([
      "#1 HVACxSTR: IfcDuctSegment (D1) × IfcBeam (B1)",
      "#2 HVACxSTR: IfcDuctSegment (D2) × IfcBeam (B1)",
      "#3 HVACxSTR: IfcDuctSegment (D3) × IfcBeam (B1)",
    ]);
  });

  it("falls back to index + 1 when clashes carry no number", () => {
    const unnumbered = CLASHES.map(({ number: _n, ...c }) => c);
    const pair = groupClashes(unnumbered).find((g) => g.kind === "pair")!;
    expect(groupToTopic(pair, 1, unnumbered).description).toContain("#4 HVACxSTR:");
  });

  it("aims the camera at the centroid, far enough back to see all members", () => {
    const hub = groups().find((g) => g.kind === "clashGroup")!;
    const t = groupToTopic(hub, 1, CLASHES);
    expect(t.position).toEqual(hub.position);
    expect(t.position[0]).toBeCloseTo(4); // centroid of x = 0, 4, 8
    // Eye sits back along (-1, -1, +1) from the target.
    const d = [0, 1, 2].map((k) => t.position[k]! - t.camera_eye[k]!);
    expect(d[0]).toBeCloseTo(d[1]!);
    expect(d[2]).toBeCloseTo(-d[0]!);
    const dist = Math.hypot(d[0]!, d[1]!, d[2]!);
    expect(dist).toBeCloseTo(cameraDistance(CLASHES.slice(0, 3).map((c) => c.position)));
    // 8 m spread + margin needs more than the single-clash 8.66 m.
    expect(dist).toBeGreaterThan(5 * Math.sqrt(3));
  });
});

describe("cameraDistance", () => {
  it("never goes closer than the single-clash camera", () => {
    expect(cameraDistance([])).toBeCloseTo(5 * Math.sqrt(3));
    expect(cameraDistance([[1, 2, 3]])).toBeCloseTo(5 * Math.sqrt(3));
  });

  it("grows with the spread of the positions", () => {
    const near = cameraDistance([
      [0, 0, 0],
      [20, 0, 0],
    ]);
    const far = cameraDistance([
      [0, 0, 0],
      [40, 0, 0],
    ]);
    expect(far).toBeGreaterThan(near);
    // Radius 10 + 2 margin over sin(32.5°).
    expect(near).toBeCloseTo(12 / Math.sin((32.5 * Math.PI) / 180));
  });
});

describe("groupsToTopics", () => {
  it("makes one topic per group, numbered 1..N in group-list order", () => {
    const gs = groups();
    const topics = groupsToTopics(gs, CLASHES);
    expect(topics).toHaveLength(gs.length);
    expect(topics.map((t) => t.title)).toEqual(gs.map((g, i) => `${i + 1} - ${g.title}`));
  });
});
