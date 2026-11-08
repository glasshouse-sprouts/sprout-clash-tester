// Tests for the preset loader.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearPresetCache,
  getPreset,
  listPresets,
  loadPresets,
  type PresetDefinition,
} from "./presets.js";

describe("loadPresets — built-in library", () => {
  beforeEach(() => clearPresetCache());

  it("loads all 13 shipped presets", () => {
    const presets = loadPresets();
    expect(presets.size).toBe(13);
    for (const name of [
      "MEPxSTR",
      "HVACxSTR",
      "HVACxARCH",
      "MEPxARCH",
      "HVACxMEP",
      "ELECxMEP",
      "FIRExSTR",
      "STRxARCH",
      "ELECxSTR",
      "ELECxARCH",
      "FIRExARCH",
      "FIRExMEP",
      "STAIRxSTR",
    ]) {
      expect(presets.has(name), `Missing preset ${name}`).toBe(true);
    }
  });

  it("each preset has a non-empty description and both sides", () => {
    for (const p of listPresets()) {
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.sideA.selector.length).toBeGreaterThan(0);
      expect(p.sideA.discipline.length).toBeGreaterThan(0);
      expect(p.sideB.selector.length).toBeGreaterThan(0);
      expect(p.sideB.discipline.length).toBeGreaterThan(0);
    }
  });

  it("getPreset returns null for unknown names", () => {
    expect(getPreset("NotAPreset")).toBeNull();
  });

  it("getPreset returns a defined object for known names", () => {
    const p = getPreset("HVACxSTR");
    expect(p).not.toBeNull();
    // Selector is now the broader Clashero-style list — assert it
    // starts with IfcDuct* (the headline type) and matches the right
    // disciplines, rather than pinning the whole string.
    expect(p!.sideA.selector.startsWith("IfcDuct*")).toBe(true);
    expect(p!.sideA.discipline).toBe("HVAC");
    expect(p!.sideB.discipline).toBe("STR");
  });
});

describe("loadPresets — custom directory + caching", () => {
  beforeEach(() => clearPresetCache());

  it("loads presets from a custom directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presets-test-"));
    const def: PresetDefinition = {
      name: "MyCustom",
      description: "test only",
      sideA: { selector: "IfcWall", discipline: "ARCH" },
      sideB: { selector: "IfcBeam", discipline: "STR" },
    };
    await writeFile(path.join(dir, "any-filename.json"), JSON.stringify(def));
    const map = loadPresets({ dir });
    expect(map.size).toBe(1);
    expect(map.get("MyCustom")!.sideA.selector).toBe("IfcWall");
  });

  it("rejects invalid preset JSON with a useful error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presets-test-"));
    await writeFile(path.join(dir, "broken.json"), "{ not json");
    expect(() => loadPresets({ dir })).toThrow(/not valid JSON/);
  });

  it("rejects a preset missing required fields", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presets-test-"));
    await writeFile(
      path.join(dir, "incomplete.json"),
      JSON.stringify({ name: "X", description: "test", sideA: { selector: "Wall" } }),
    );
    expect(() => loadPresets({ dir })).toThrow(/discipline/);
  });

  it("rejects two presets with the same name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "presets-test-"));
    const def = {
      name: "Dup",
      description: "",
      sideA: { selector: "*", discipline: "A" },
      sideB: { selector: "*", discipline: "B" },
    };
    await writeFile(path.join(dir, "a.json"), JSON.stringify(def));
    await writeFile(path.join(dir, "b.json"), JSON.stringify(def));
    expect(() => loadPresets({ dir })).toThrow(/multiple files/);
  });
});
