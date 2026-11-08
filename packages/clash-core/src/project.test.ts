// Unit tests for project file load / save / validate / expand.
// No engine spawning here — pure data shaping.

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  expandProjectToRules,
  loadProject,
  saveProject,
  validateProject,
  type Project,
} from "./project.js";

/** Hand-rolled valid project for use across tests. */
function sampleProject(): Project {
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: "Sample",
    createdAt: "2026-05-16T10:00:00Z",
    files: [
      { id: "ark", path: "/abs/ARK.ifc", discipline: "ARCH" },
      { id: "vent", path: "/abs/VENT.ifc", discipline: "HVAC", translation: [0, 0, 0] },
    ],
    rules: [
      {
        name: "HVACxARCH",
        preset: null,
        enabled: true,
        a: { fileId: "vent", selector: "IfcDuct*", mode: "i" },
        b: { fileId: "ark", selector: "IfcWall|IfcSlab", mode: "i" },
      },
    ],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

describe("validateProject — happy path", () => {
  it("accepts a hand-built project unchanged", () => {
    const p = validateProject(sampleProject());
    expect(p.name).toBe("Sample");
    expect(p.files).toHaveLength(2);
    expect(p.rules).toHaveLength(1);
    expect(p.settings.toleranceMeters).toBe(0);
  });

  it("preserves translation arrays", () => {
    const raw = {
      ...sampleProject(),
      files: [
        { id: "ark", path: "/abs/ARK.ifc" },
        { id: "vent", path: "/abs/VENT.ifc", translation: [1.5, 2.0, -3.25] },
      ],
    };
    const p = validateProject(raw);
    expect(p.files[1]?.translation).toEqual([1.5, 2.0, -3.25]);
  });
});

describe("validateProject — error reporting", () => {
  it("rejects wrong version", () => {
    const bad = { ...sampleProject(), version: 99 };
    expect(() => validateProject(bad)).toThrow(ProjectValidationError);
  });

  it("rejects empty files array", () => {
    const bad = { ...sampleProject(), files: [] };
    expect(() => validateProject(bad)).toThrow(/files must be a non-empty array/);
  });

  it("rejects duplicate file ids", () => {
    const bad = {
      ...sampleProject(),
      files: [
        { id: "dup", path: "/a.ifc" },
        { id: "dup", path: "/b.ifc" },
      ],
    };
    expect(() => validateProject(bad)).toThrow(/duplicated/);
  });

  it("rejects rule referring to unknown fileId", () => {
    const bad = {
      ...sampleProject(),
      rules: [
        {
          name: "Bad",
          preset: null,
          a: { fileId: "nope", selector: "*" },
          b: { fileId: "ark", selector: "*" },
        },
      ],
    };
    expect(() => validateProject(bad)).toThrow(/does not match any files/);
  });

  it("rejects negative tolerance", () => {
    const bad = {
      ...sampleProject(),
      settings: { toleranceMeters: -1, minPenetrationMeters: 0.005 },
    };
    expect(() => validateProject(bad)).toThrow(/toleranceMeters must be >= 0/);
  });

  it("reports multiple issues at once", () => {
    const bad = { version: 2, name: "", createdAt: 123, files: "not array", rules: "" };
    try {
      validateProject(bad);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectValidationError);
      expect((e as ProjectValidationError).issues.length).toBeGreaterThan(1);
    }
  });
});

describe("loadProject / saveProject — round trip", () => {
  it("survives a round trip through disk", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "clashproj-test-"));
    const file = path.join(work, "sample.clashproj");
    const original = sampleProject();
    // Make paths relative so the load-time resolution kicks in.
    original.files = [
      { id: "ark", path: "ARK.ifc", discipline: "ARCH" },
      { id: "vent", path: "VENT.ifc", discipline: "HVAC", translation: [0, 0, 0] },
    ];
    await saveProject(file, original);
    const reloaded = await loadProject(file);
    expect(reloaded.name).toBe(original.name);
    expect(reloaded.files).toHaveLength(2);
    // Relative paths resolved to absolute against the project file's dir.
    expect(path.isAbsolute(reloaded.files[0]!.path)).toBe(true);
    expect(reloaded.files[0]!.path.endsWith("ARK.ifc")).toBe(true);
  });

  it("rejects invalid JSON with a clear error", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "clashproj-test-"));
    const file = path.join(work, "bad.clashproj");
    await writeFile(file, "{ not valid json");
    await expect(loadProject(file)).rejects.toThrow(/not valid JSON/);
  });
});

describe("expandProjectToRules", () => {
  it("turns a custom rule into one ClashRule with both sides", () => {
    const rules = expandProjectToRules(sampleProject());
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("HVACxARCH");
    expect(rules[0]?.a[0]?.selector).toBe("IfcDuct*");
    expect(rules[0]?.b[0]?.selector).toBe("IfcWall|IfcSlab");
    expect(rules[0]?.a[0]?.file).toBe("/abs/VENT.ifc");
  });

  it("drops disabled rules", () => {
    const p = sampleProject();
    p.rules[0]!.enabled = false;
    expect(expandProjectToRules(p)).toHaveLength(0);
  });

  it("expands a preset rule using the loaded preset library", () => {
    const p: Project = {
      ...sampleProject(),
      files: [
        { id: "vent", path: "/abs/VENT.ifc", discipline: "HVAC" },
        { id: "kon", path: "/abs/KON.ifc", discipline: "STR" },
      ],
      rules: [{ name: "HVACxSTR", preset: "HVACxSTR", enabled: true }],
    };
    const rules = expandProjectToRules(p);
    expect(rules).toHaveLength(1);
    // Selectors now use the broader Clashero-style list — assert
    // that the headline IFC type is the first entry rather than
    // pinning the whole string.
    expect(rules[0]?.a[0]?.selector?.startsWith("IfcDuct*")).toBe(true);
    expect(rules[0]?.b[0]?.selector?.startsWith("IfcBeam*")).toBe(true);
    expect(rules[0]?.a[0]?.file).toBe("/abs/VENT.ifc"); // from project files
    expect(rules[0]?.b[0]?.file).toBe("/abs/KON.ifc");
  });

  it("warns and skips a preset rule when no files match the discipline", () => {
    const p: Project = {
      ...sampleProject(),
      files: [{ id: "ark", path: "/abs/ARK.ifc", discipline: "ARCH" }],
      // HVACxSTR needs HVAC + STR, but project only has ARCH.
      rules: [{ name: "HVACxSTR", preset: "HVACxSTR", enabled: true }],
    };
    const warnings: string[] = [];
    const rules = expandProjectToRules(p, { onWarning: (m) => warnings.push(m) });
    expect(rules).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/HVAC/);
  });

  it("warns and skips a preset rule when the preset name is unknown", () => {
    const p: Project = {
      ...sampleProject(),
      rules: [{ name: "Bogus", preset: "DoesNotExist", enabled: true }],
    };
    const warnings: string[] = [];
    const rules = expandProjectToRules(p, { onWarning: (m) => warnings.push(m) });
    expect(rules).toHaveLength(0);
    expect(warnings[0]).toMatch(/DoesNotExist/);
  });

  it("attaches per-file translation to the expanded SelectionGroup", () => {
    const p = sampleProject();
    p.files[1]!.translation = [10, 0, 0];
    const rules = expandProjectToRules(p);
    expect(rules[0]?.a[0]?.translation).toEqual([10, 0, 0]);
  });

  it("defaults selector to '*' when omitted", () => {
    const p: Project = {
      ...sampleProject(),
      rules: [
        {
          name: "X",
          preset: null,
          a: { fileId: "ark" },
          b: { fileId: "vent" },
        },
      ],
    };
    const rules = expandProjectToRules(p);
    expect(rules[0]?.a[0]?.selector).toBe("*");
    expect(rules[0]?.b[0]?.selector).toBe("*");
  });

  it("passes a side's exclude through; omits it when absent", () => {
    const p = sampleProject();
    const rule = p.rules[0] as { a: { exclude?: string } };
    rule.a.exclude = "IfcSpace|IfcOpeningElement";
    const rules = expandProjectToRules(p);
    expect(rules[0]?.a[0]?.exclude).toBe("IfcSpace|IfcOpeningElement");
    expect(rules[0]?.b[0]).not.toHaveProperty("exclude");
  });
});

describe("validateProject — settings.bcfTopics (SPEC §13c)", () => {
  const withTopics = (bcfTopics: unknown) => ({
    ...sampleProject(),
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005, bcfTopics },
  });

  it("accepts clash and group; omitted stays omitted (= per clash)", () => {
    expect(validateProject(withTopics("group")).settings.bcfTopics).toBe("group");
    expect(validateProject(withTopics("clash")).settings.bcfTopics).toBe("clash");
    expect(validateProject(sampleProject()).settings.bcfTopics).toBeUndefined();
  });

  it("rejects other values", () => {
    expect(() => validateProject(withTopics("groups"))).toThrow(/bcfTopics must be "clash" or "group"/);
  });
});

describe("validateProject — settings.narrowPhase / reportTouch (SPEC §13g)", () => {
  const withNarrow = (extra: Record<string, unknown>) => ({
    ...sampleProject(),
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005, ...extra },
  });

  it("keeps parry / ifclite and the touch flag; omitted stays omitted", () => {
    const s = validateProject(withNarrow({ narrowPhase: "ifclite", reportTouch: true })).settings;
    expect(s.narrowPhase).toBe("ifclite");
    expect(s.reportTouch).toBe(true);
    expect(validateProject(withNarrow({ narrowPhase: "parry" })).settings.narrowPhase).toBe("parry");
    expect(validateProject(sampleProject()).settings).not.toHaveProperty("narrowPhase");
    expect(validateProject(sampleProject()).settings).not.toHaveProperty("reportTouch");
  });

  it("rejects unknown phases and non-boolean touch flags", () => {
    expect(() => validateProject(withNarrow({ narrowPhase: "fast" }))).toThrow(/narrowPhase must be "parry" or "ifclite"/);
    expect(() => validateProject(withNarrow({ reportTouch: "yes" }))).toThrow(/reportTouch must be true or false/);
  });
});

describe("validateProject — settings.skipRelatedElements (SPEC §13e)", () => {
  const withSkip = (skipRelatedElements: unknown) => ({
    ...sampleProject(),
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005, skipRelatedElements },
  });

  it("keeps true / false; omitted stays omitted (= on)", () => {
    expect(validateProject(withSkip(false)).settings.skipRelatedElements).toBe(false);
    expect(validateProject(withSkip(true)).settings.skipRelatedElements).toBe(true);
    expect(validateProject(sampleProject()).settings).not.toHaveProperty("skipRelatedElements");
  });

  it("rejects non-booleans", () => {
    expect(() => validateProject(withSkip("no"))).toThrow(/skipRelatedElements must be true or false/);
  });
});

describe("validateProject — rule side exclude (SPEC §7, §13b)", () => {
  function withExclude(exclude: unknown): unknown {
    const p = sampleProject();
    return {
      ...p,
      rules: [{ ...p.rules[0], a: { fileId: "ark", selector: "*", exclude } }],
    };
  }

  it("keeps a non-empty exclude", () => {
    const p = validateProject(withExclude("IfcSpace|IfcOpening*"));
    expect((p.rules[0] as { a: { exclude?: string } }).a.exclude).toBe("IfcSpace|IfcOpening*");
  });

  it("rejects an empty or non-string exclude", () => {
    expect(() => validateProject(withExclude(""))).toThrow(/exclude must be a non-empty string/);
    expect(() => validateProject(withExclude("  "))).toThrow(/exclude must be a non-empty string/);
    expect(() => validateProject(withExclude(42))).toThrow(/rules\[0\]\.a\.exclude/);
  });

  it("projects without exclude still validate (backwards compatible)", () => {
    const p = validateProject(sampleProject());
    expect(p.rules[0]).not.toHaveProperty("a.exclude");
  });
});

describe("validateProject — settings.grouping (SPEC §13a)", () => {
  function withGrouping(grouping: unknown): unknown {
    const p = sampleProject();
    return { ...p, settings: { ...p.settings, grouping } };
  }

  it("grouping is optional", () => {
    expect(validateProject(sampleProject()).settings.grouping).toBeUndefined();
  });

  it("accepts a full grouping block", () => {
    const p = validateProject(
      withGrouping({ minElementClashes: 3, proximity: { enabled: true, radiusMetres: 1.5 } }),
    );
    expect(p.settings.grouping).toEqual({
      minElementClashes: 3,
      proximity: { enabled: true, radiusMetres: 1.5 },
    });
  });

  it("accepts an empty grouping block (all defaults)", () => {
    expect(validateProject(withGrouping({})).settings.grouping).toEqual({});
  });

  it("rejects minElementClashes below 2 or fractional", () => {
    expect(() => validateProject(withGrouping({ minElementClashes: 1 }))).toThrow(
      /minElementClashes must be an integer >= 2/,
    );
    expect(() => validateProject(withGrouping({ minElementClashes: 2.5 }))).toThrow(
      ProjectValidationError,
    );
  });

  it("rejects a non-positive proximity radius", () => {
    expect(() =>
      validateProject(withGrouping({ proximity: { enabled: true, radiusMetres: 0 } })),
    ).toThrow(/radiusMetres must be a number > 0/);
  });

  it("rejects proximity without an enabled flag", () => {
    expect(() => validateProject(withGrouping({ proximity: { radiusMetres: 2 } }))).toThrow(
      /proximity.enabled must be true or false/,
    );
  });

  it("validates duplicate thresholds", () => {
    expect(
      validateProject(
        withGrouping({ duplicate: { maxVolumeDifference: 0.1, maxCentroidDistanceMetres: 0.05 } }),
      ).settings.grouping,
    ).toEqual({ duplicate: { maxVolumeDifference: 0.1, maxCentroidDistanceMetres: 0.05 } });
    expect(validateProject(withGrouping({ duplicate: {} })).settings.grouping).toEqual({
      duplicate: {},
    });
    expect(() =>
      validateProject(withGrouping({ duplicate: { maxVolumeDifference: 1.5 } })),
    ).toThrow(/maxVolumeDifference must be between 0 and 1/);
    expect(() =>
      validateProject(withGrouping({ duplicate: { maxCentroidDistanceMetres: -1 } })),
    ).toThrow(/maxCentroidDistanceMetres must be a number >= 0/);
    expect(() => validateProject(withGrouping({ duplicate: 3 }))).toThrow(
      /duplicate must be an object/,
    );
  });

  it("rejects a non-object grouping", () => {
    expect(() => validateProject(withGrouping("yes"))).toThrow(/grouping must be an object/);
  });

  it("survives a save/load round trip", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clashproj-grouping-"));
    const file = path.join(dir, "g.clashproj");
    const p = validateProject(
      withGrouping({ proximity: { enabled: true, radiusMetres: 2 } }),
    );
    await saveProject(file, p);
    const back = await loadProject(file);
    expect(back.settings.grouping).toEqual({ proximity: { enabled: true, radiusMetres: 2 } });
  });
});
