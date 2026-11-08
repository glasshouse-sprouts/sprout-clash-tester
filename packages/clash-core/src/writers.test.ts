// Tests for the JSON + CSV writers. Pure-data — no engine spawning.

import { describe, it, expect } from "vitest";
import { csvForResult } from "./writers.js";
import type { RunResult } from "./types.js";

function sampleResult(): RunResult {
  return {
    ok: true,
    exitCode: 0,
    totalClashes: 2,
    perRule: [{ name: "HVACxSTR", clashes: 2 }],
    clashes: [
      {
        rule: "HVACxSTR",
        ifcTypeA: "IfcDuctSegment",
        ifcTypeB: "IfcBeam",
        guidA: "abc-123",
        guidB: "def-456",
        fileA: "HVAC.ifc",
        fileB: "STR.ifc",
        position: [1.234567, 2, 3.5],
        mode: "intersection",
        depthMetres: 0.06,
        gapMetres: null,
        aabbOverlapExtents: [0.06, 0.2, 0.5],
        aabbOverlapVolume: 0.006,
      },
      {
        rule: "HVACxSTR",
        ifcTypeA: "IfcDuctFitting",
        ifcTypeB: "IfcColumn",
        // Test CSV escaping: comma in a GUID is implausible but possible
        // in user-provided strings; we still want it safe.
        guidA: "comma,inside",
        guidB: "quote\"inside",
        fileA: "HVAC.ifc",
        fileB: "STR.ifc",
        position: [-0.000001, 0, 100],
        mode: "clearance",
        depthMetres: null,
        gapMetres: 0.03,
        aabbOverlapExtents: null,
        aabbOverlapVolume: null,
      },
    ],
    warnings: [],
    outputs: { summary: "/tmp/sum.json" },
    stdout: "",
    stderr: "",
  };
}

describe("csvForResult", () => {
  it("ends each row with the type-object class and PredefinedType (SPEC §6)", () => {
    const r = sampleResult();
    r.clashes[0] = {
      ...r.clashes[0]!,
      ifcTypeA: "IFCFLOWSEGMENT",
      typeClassA: "IfcDuctSegment",
      predefinedTypeA: "RIGIDSEGMENT",
    };
    const rows = csvForResult(r).trim().split("\n");
    expect(rows[1]).toContain(",IFCFLOWSEGMENT,");
    expect(rows[1]!.endsWith(",IfcDuctSegment,RIGIDSEGMENT,,")).toBe(true);
  });

  it("ends each row with the ifc-lite status and distance kind (SPEC §13g)", () => {
    const r = sampleResult();
    r.clashes[0] = { ...r.clashes[0], status: "hard", distanceKind: "estimate" };
    const rows = csvForResult(r).trim().split("\n");
    expect(rows[1].endsWith(",hard,estimate,,,,")).toBe(true);
    expect(rows[2].endsWith(",,")).toBe(true); // parry rows: empty cells
  });

  it("writes a header row and one row per clash", () => {
    const csv = csvForResult(sampleResult());
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe(
      "no,rule,fileA,ifcTypeA,guidA,fileB,ifcTypeB,guidB,posX,posY,posZ,mode,depthM,gapM,aabbDx,aabbDy,aabbDz,aabbVolumeM3,aabbMatch,volumeAM3,volumeBM3,centroidDistM,likelyDuplicate,status,distanceKind,typeClassA,predefinedTypeA,typeClassB,predefinedTypeB",
    );
    expect(rows).toHaveLength(3); // header + 2 clashes
  });

  it("numbers rows from the clash's own number (BCF title prefix)", () => {
    const r = sampleResult();
    r.clashes[0]!.number = 1;
    r.clashes[1]!.number = 2;
    const rows = csvForResult(r).trim().split("\n");
    expect(rows[1]!.startsWith("1,HVACxSTR,")).toBe(true);
    expect(rows[2]!.startsWith("2,HVACxSTR,")).toBe(true);
  });

  it("falls back to row position + 1 for results without numbers", () => {
    const rows = csvForResult(sampleResult()).trim().split("\n");
    expect(rows.slice(1).map((row) => row.split(",")[0])).toEqual(["1", "2"]);
  });

  it("includes the source file basenames", () => {
    const csv = csvForResult(sampleResult());
    expect(csv).toContain("HVAC.ifc");
    expect(csv).toContain("STR.ifc");
  });

  it("includes mode + depth/gap + AABB fields per clash", () => {
    const csv = csvForResult(sampleResult());
    // First clash: intersection, depth set, gap empty.
    expect(csv).toMatch(/intersection,0\.06,,0\.06,0\.2,0\.5,0\.006/);
    // Second clash: clearance, gap set, AABB fields empty.
    expect(csv).toMatch(/clearance,,0\.03,,,,/);
  });

  it("writes volumes, centre distance and flags likely duplicates", () => {
    const r = sampleResult();
    // Clash 0 becomes a same-type, same-volume, same-place pair.
    Object.assign(r.clashes[0]!, {
      ifcTypeB: "IfcDuctSegment",
      aabbMatch: 0.97,
      volumeA: 0.5,
      volumeB: 0.49,
      centroidDistanceMetres: 0.004,
    });
    // Clash 1: different types — never a duplicate.
    Object.assign(r.clashes[1]!, { aabbMatch: 0.99, volumeA: 1, volumeB: 1, centroidDistanceMetres: 0 });
    const rows = csvForResult(r).trim().split("\n");
    expect(rows[1]).toMatch(/,0\.97,0\.5,0\.49,0\.004,yes,,,,,,$/);
    expect(rows[2]).toMatch(/,0\.99,1,1,0,,,,,,,$/);
  });

  it("uses the run's duplicate groups when present", () => {
    const r = sampleResult();
    r.groups = [
      {
        key: "duplicate:x",
        kind: "duplicate",
        title: "t",
        element: null,
        clashIndices: [1],
        clashKeys: ["x"],
        pairCount: 1,
        rules: [],
        position: [0, 0, 0],
        maxDepthMetres: null,
        minGapMetres: null,
        aabbOverlapVolume: null,
      },
    ];
    const rows = csvForResult(r).trim().split("\n");
    expect(rows[1]).toMatch(/,$/);
    expect(rows[2]).toMatch(/,yes,,,,,,$/);
  });

  it("formats numbers without exponential notation", () => {
    const csv = csvForResult(sampleResult());
    expect(csv).not.toMatch(/e[+-]/i);
    // Trailing-zero stripping: 2.0 -> "2"; 3.5 stays "3.5"
    expect(csv).toMatch(/,2,/);
    // 3.5 is the Z coordinate of the first clash; followed by `,intersection`
    // since we now emit per-clash mode/depth/gap/AABB after position.
    expect(csv).toMatch(/,3\.5,intersection/);
  });

  it("quotes cells containing commas or quotes", () => {
    const csv = csvForResult(sampleResult());
    expect(csv).toMatch(/"comma,inside"/);
    expect(csv).toMatch(/"quote""inside"/);
  });

  it("handles an empty clashes array", () => {
    const empty: RunResult = { ...sampleResult(), totalClashes: 0, clashes: [] };
    const csv = csvForResult(empty);
    expect(csv.trim().split("\n")).toHaveLength(1); // header only
  });

  it("missing optional fields render as empty cells, not 'null'", () => {
    const r: RunResult = {
      ...sampleResult(),
      totalClashes: 1,
      clashes: [
        {
          rule: "X",
          fileA: "a.ifc",
          ifcTypeA: "IfcA",
          guidA: "g1",
          fileB: "b.ifc",
          ifcTypeB: "IfcB",
          guidB: "g2",
          position: [0, 0, 0],
          mode: "",
          depthMetres: null,
          gapMetres: null,
          aabbOverlapExtents: null,
          aabbOverlapVolume: null,
        },
      ],
    };
    const csv = csvForResult(r);
    // No "null" / "undefined" tokens anywhere.
    expect(csv).not.toMatch(/null|undefined/);
  });
});
