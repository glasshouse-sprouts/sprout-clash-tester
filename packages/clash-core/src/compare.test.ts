// diffByRule: per-rule agreement between the two narrow phases
// (docs/HOW-IT-WORKS.md#ifc-lite-narrow-phase).

import { describe, expect, it } from "vitest";
import { diffByRule } from "./compare.js";
import type { ClashEntry, RunResult } from "./types.js";

function clash(rule: string, a: string, b: string): ClashEntry {
  return {
    rule,
    ifcTypeA: "IfcDoor",
    ifcTypeB: "IfcWall",
    guidA: a,
    guidB: b,
    fileA: "m.ifc",
    fileB: "m.ifc",
    position: [0, 0, 0],
    mode: "intersection",
    depthMetres: 0.01,
    gapMetres: null,
    aabbOverlapExtents: null,
    aabbOverlapVolume: null,
  };
}

function result(perRule: RunResult["perRule"], clashes: ClashEntry[]): RunResult {
  return {
    ok: true,
    exitCode: 0,
    totalClashes: clashes.length,
    perRule,
    clashes,
    warnings: [],
    outputs: { summary: "" },
    stdout: "",
    stderr: "",
  };
}

describe("diffByRule", () => {
  it("counts both / only parry / only ifc-lite per rule, pair order ignored", () => {
    const parry = result(
      [{ name: "R1", clashes: 3 }],
      [clash("R1", "d1", "w1"), clash("R1", "d2", "w1"), clash("R1", "d3", "w1")],
    );
    const ifclite = result(
      [
        { name: "R1", clashes: 2, touchCount: 2, unconfirmedCount: 1 },
        { name: "R2", clashes: 1, touchCount: 0, unconfirmedCount: 0 },
      ],
      [clash("R1", "w1", "d1"), clash("R1", "d9", "w1"), clash("R2", "x", "y")],
    );
    expect(diffByRule(parry, ifclite)).toEqual([
      { rule: "R1", both: 1, onlyParry: 2, onlyIfclite: 1, touch: 2, unconfirmed: 1 },
      { rule: "R2", both: 0, onlyParry: 0, onlyIfclite: 1, touch: 0, unconfirmed: 0 },
    ]);
  });

  it("keeps the same pair in two rules apart", () => {
    const parry = result([], [clash("R1", "a", "b")]);
    const ifclite = result([], [clash("R2", "a", "b")]);
    const rows = diffByRule(parry, ifclite);
    expect(rows.find((r) => r.rule === "R1")?.onlyParry).toBe(1);
    expect(rows.find((r) => r.rule === "R2")?.onlyIfclite).toBe(1);
  });
});
