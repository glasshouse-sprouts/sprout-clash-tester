// Smoke test — confirms vitest runs and the package is importable.
import { describe, expect, it } from "vitest";
import { VERSION, formatIfcClass, formatOpeningCuts } from "./index.js";

describe("@clash-tester/core", () => {
  it("exposes a version string", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("shows the type-object class after the occurrence class", () => {
    expect(formatIfcClass("IFCFLOWSEGMENT", "IfcDuctSegment")).toBe(
      "IFCFLOWSEGMENT → IfcDuctSegment",
    );
    expect(formatIfcClass("IFCBEAM")).toBe("IFCBEAM");
  });

  it("names cut hosts with an open mesh only when there are some", () => {
    const c = { hostsCut: 3, openings: 4, failed: [], notCut: ["O1"] };
    expect(formatOpeningCuts(c)).toBe(
      "opening cuts: 3 hosts cut, 4 openings, 0 failed, 1 not cut",
    );
    expect(formatOpeningCuts({ ...c, openMesh: ["W1", "W2"] })).toBe(
      "opening cuts: 3 hosts cut, 4 openings, 0 failed, 1 not cut, 2 with open mesh",
    );
  });
});
