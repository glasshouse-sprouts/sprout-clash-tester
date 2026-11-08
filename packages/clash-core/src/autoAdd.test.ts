// Tests for the auto-add-presets helpers.
//
// These are pure data transformations — no file IO beyond the shipped
// presets/ directory the loader walks up to find.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  autoAddPresets,
  suggestPresetsForProject,
  type Project,
} from "./index.js";

function projectWith(files: { id: string; discipline?: string }[]): Project {
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: "auto-add test",
    createdAt: "2026-05-17T00:00:00Z",
    files: files.map((f) => ({
      id: f.id,
      path: `/abs/${f.id}.ifc`,
      discipline: f.discipline,
    })),
    rules: [],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

describe("suggestPresetsForProject", () => {
  it("HVAC + STR → suggests HVACxSTR (at minimum)", () => {
    const p = projectWith([
      { id: "vent", discipline: "HVAC" },
      { id: "str", discipline: "STR" },
    ]);
    const suggestions = suggestPresetsForProject(p);
    const names = suggestions.map((s) => s.name);
    expect(names).toContain("HVACxSTR");
  });

  it("returns nothing when only one discipline is present", () => {
    const p = projectWith([
      { id: "a", discipline: "HVAC" },
      { id: "b", discipline: "HVAC" },
    ]);
    expect(suggestPresetsForProject(p)).toHaveLength(0);
  });

  it("ignores UNKNOWN and missing disciplines", () => {
    const p = projectWith([
      { id: "ark", discipline: "ARCH" },
      { id: "x", discipline: "UNKNOWN" },
      { id: "y" },
    ]);
    // Only ARCH is "real", so nothing matches.
    expect(suggestPresetsForProject(p)).toHaveLength(0);
  });

  it("skips presets already present in the project (by name)", () => {
    const p = projectWith([
      { id: "vent", discipline: "HVAC" },
      { id: "str", discipline: "STR" },
    ]);
    // Pretend HVACxSTR is already there.
    p.rules.push({ name: "HVACxSTR", preset: "HVACxSTR", enabled: true });
    const names = suggestPresetsForProject(p).map((s) => s.name);
    expect(names).not.toContain("HVACxSTR");
  });

  it("HVAC + STR + ARCH suggests several presets", () => {
    const p = projectWith([
      { id: "vent", discipline: "HVAC" },
      { id: "str", discipline: "STR" },
      { id: "ark", discipline: "ARCH" },
    ]);
    const names = suggestPresetsForProject(p).map((s) => s.name);
    // We expect at least: HVACxSTR, HVACxARCH, STRxARCH, STAIRxSTR.
    expect(names).toEqual(expect.arrayContaining(["HVACxSTR", "HVACxARCH", "STRxARCH"]));
  });
});

describe("autoAddPresets", () => {
  it("adds applicable presets and reports their names", () => {
    const p = projectWith([
      { id: "vent", discipline: "HVAC" },
      { id: "str", discipline: "STR" },
    ]);
    const result = autoAddPresets(p);
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.added).toContain("HVACxSTR");
    // Returned project should have the new rules at the end.
    expect(result.project.rules.length).toBe(result.added.length);
    expect(result.project.rules.every((r) => "preset" in r)).toBe(true);
  });

  it("returns empty when nothing is applicable", () => {
    const p = projectWith([{ id: "lone", discipline: "ARCH" }]);
    const result = autoAddPresets(p);
    expect(result.added).toEqual([]);
    expect(result.project).toBe(p); // same identity — no allocation
  });

  it("is idempotent: running twice doesn't re-add", () => {
    const p = projectWith([
      { id: "vent", discipline: "HVAC" },
      { id: "str", discipline: "STR" },
    ]);
    const r1 = autoAddPresets(p);
    const r2 = autoAddPresets(r1.project);
    expect(r2.added).toEqual([]);
    expect(r2.project.rules).toEqual(r1.project.rules);
  });

  it("disciplinesSeen reports what the helper saw (for empty cases)", () => {
    const p = projectWith([
      { id: "ark", discipline: "ARCH" },
      { id: "x", discipline: "UNKNOWN" },
    ]);
    const r = autoAddPresets(p);
    expect(r.disciplinesSeen).toEqual(["ARCH"]);
  });
});
