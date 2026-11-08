// Tests for the pure-data helpers in state.ts. No DOM / Electron.

import { describe, expect, it } from "vitest";
import {
  addCustomRule,
  addSelfCheckRule,
  customRuleFields,
  runBlockedReason,
  updateCustomRule,
  addFileToProject,
  addPresetRule,
  classifyDroppedPaths,
  removeFileFromProject,
  removeRule,
  groupKindLabel,
  setBcfTopics,
  setFileDiscipline,
  setNarrowPhase,
  setReportTouch,
  setSkipRelatedElements,
  toggleRule,
  uniqueFileId,
} from "./state";
import type { Project } from "@clash-tester/core";

function sample(): Project {
  return {
    version: 1,
    name: "test",
    createdAt: "2026-05-16T00:00:00Z",
    files: [{ id: "vent", path: "/a/VENT.ifc", discipline: "HVAC" }],
    rules: [],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

describe("classifyDroppedPaths", () => {
  it("splits .ifc files from everything else", () => {
    const { ifcs, ignored } = classifyDroppedPaths([
      { path: "/a/x.ifc", isFile: true, isIfc: true },
      { path: "/a/y.txt", isFile: true, isIfc: false },
      { path: "/a/folder", isFile: false, isIfc: false },
    ]);
    expect(ifcs).toEqual(["/a/x.ifc"]);
    expect(ignored).toEqual(["/a/y.txt", "/a/folder"]);
  });
});

describe("uniqueFileId", () => {
  it("returns the basename without extension if available", () => {
    expect(uniqueFileId(sample(), "/some/path/ARK.ifc")).toBe("ark");
  });

  it("appends a numeric suffix when colliding", () => {
    const p = sample();
    expect(uniqueFileId(p, "/anywhere/VENT.ifc")).toBe("vent-2");
  });

  it("snake-cases and strips special characters", () => {
    expect(uniqueFileId(sample(), "/x/Hello World!.ifc")).toBe("hello-world-");
  });
});

describe("addFileToProject", () => {
  it("appends with a fresh id and the given discipline", () => {
    const p = addFileToProject(sample(), "/x/STR.ifc", "STR");
    expect(p.files).toHaveLength(2);
    expect(p.files[1]!.id).toBe("str");
    expect(p.files[1]!.discipline).toBe("STR");
  });

  it("does not mutate the input", () => {
    const orig = sample();
    const next = addFileToProject(orig, "/x/STR.ifc", "STR");
    expect(orig.files).toHaveLength(1);
    expect(next).not.toBe(orig);
  });

  it("infers discipline from filename when none is passed", () => {
    const p = addFileToProject(sample(), "/x/Building-Hvac.ifc");
    expect(p.files[1]!.discipline).toBe("HVAC");
  });

  it("infers UNKNOWN for filenames with no recognisable signal", () => {
    const p = addFileToProject(sample(), "/x/random-name.ifc");
    expect(p.files[1]!.discipline).toBe("UNKNOWN");
  });
});

describe("removeFileFromProject", () => {
  it("drops the file and any rules referring to it", () => {
    let p = sample();
    p = addFileToProject(p, "/x/STR.ifc", "STR");
    p = addCustomRule(p, "rule1", "vent", "*", "str", "*");
    p = removeFileFromProject(p, "vent");
    expect(p.files.map((f) => f.id)).toEqual(["str"]);
    expect(p.rules).toHaveLength(0);
  });
});

describe("setFileDiscipline", () => {
  it("changes the discipline on the target file only", () => {
    const next = setFileDiscipline(sample(), "vent", "MEP");
    expect(next.files[0]!.discipline).toBe("MEP");
  });
});

describe("rules helpers", () => {
  it("addPresetRule appends a preset-shaped rule", () => {
    const p = addPresetRule(sample(), "HVACxSTR");
    expect(p.rules).toHaveLength(1);
    expect((p.rules[0] as { preset: string }).preset).toBe("HVACxSTR");
  });

  it("addCustomRule appends a custom-shape rule", () => {
    let p = sample();
    p = addFileToProject(p, "/x/STR.ifc", "STR");
    p = addCustomRule(p, "mine", "vent", "IfcDuct*", "str", "IfcBeam");
    expect(p.rules).toHaveLength(1);
    expect((p.rules[0] as { a: { selector: string } }).a.selector).toBe("IfcDuct*");
  });

  it("toggleRule flips enabled flag", () => {
    let p = addPresetRule(sample(), "HVACxSTR");
    p = toggleRule(p, "HVACxSTR");
    expect(p.rules[0]!.enabled).toBe(false);
    p = toggleRule(p, "HVACxSTR");
    expect(p.rules[0]!.enabled).toBe(true);
  });

  it("removeRule drops by name", () => {
    let p = addPresetRule(sample(), "HVACxSTR");
    p = removeRule(p, "HVACxSTR");
    expect(p.rules).toHaveLength(0);
  });
});

describe("addSelfCheckRule", () => {
  it("adds a rule with the same file on both sides, all types", () => {
    const p = addSelfCheckRule(sample(), "vent");
    expect(p.rules).toHaveLength(1);
    const r = p.rules[0]! as {
      name: string;
      preset: null;
      a: { fileId: string; selector: string };
      b: { fileId: string; selector: string };
    };
    expect(r.name).toBe("SELF-vent");
    expect(r.preset).toBeNull();
    expect(r.a).toMatchObject({ fileId: "vent", selector: "*" });
    expect(r.b).toMatchObject({ fileId: "vent", selector: "*" });
  });

  it("ignores spaces and openings on both sides by default", () => {
    const r = addSelfCheckRule(sample(), "vent").rules[0]! as {
      a: { exclude?: string };
      b: { exclude?: string };
    };
    expect(r.a.exclude).toBe("IfcSpace|IfcSpatialZone|IfcOpeningElement|IfcOpeningStandardCase");
    expect(r.b.exclude).toBe(r.a.exclude);
  });

  it("can keep spaces and openings (checkbox off)", () => {
    const r = addSelfCheckRule(sample(), "vent", { ignoreSpacesAndOpenings: false }).rules[0]!;
    expect((r as { a: object }).a).not.toHaveProperty("exclude");
    expect((r as { b: object }).b).not.toHaveProperty("exclude");
  });

  it("is idempotent", () => {
    const once = addSelfCheckRule(sample(), "vent");
    expect(addSelfCheckRule(once, "vent")).toBe(once);
  });

  it("ignores unknown file ids", () => {
    const p = sample();
    expect(addSelfCheckRule(p, "nope")).toBe(p);
  });
});

describe("groupKindLabel", () => {
  it("shows clashGroup — and the old 'element' kind — as Clash group", () => {
    expect(groupKindLabel("clashGroup")).toBe("Clash group");
    expect(groupKindLabel("element")).toBe("Clash group");
  });

  it("keeps the other kinds; unknown kinds pass through", () => {
    expect(groupKindLabel("duplicate")).toBe("double?");
    expect(groupKindLabel("pair")).toBe("pair");
    expect(groupKindLabel("area")).toBe("area");
    expect(groupKindLabel("future")).toBe("future");
  });
});

describe("setBcfTopics", () => {
  it("stores group, and clears the setting for the per-clash default", () => {
    const grouped = setBcfTopics(sample(), "group");
    expect(grouped.settings.bcfTopics).toBe("group");
    const back = setBcfTopics(grouped, "clash");
    expect(back.settings).not.toHaveProperty("bcfTopics");
    expect(back.settings.toleranceMeters).toBe(sample().settings.toleranceMeters);
  });
});

describe("setSkipRelatedElements", () => {
  it("stores off explicitly and on by removing the key", () => {
    const off = setSkipRelatedElements(sample(), false);
    expect(off.settings.skipRelatedElements).toBe(false);
    expect(setSkipRelatedElements(off, true).settings).not.toHaveProperty("skipRelatedElements");
  });
});

describe("setNarrowPhase / setReportTouch", () => {
  it("stores ifclite explicitly and parry by removing the key", () => {
    const on = setNarrowPhase(sample(), "ifclite");
    expect(on.settings.narrowPhase).toBe("ifclite");
    expect(setNarrowPhase(on, "parry").settings).not.toHaveProperty("narrowPhase");
  });

  it("drops the touch flag when going back to parry, keeps it within ifclite", () => {
    const touching = setReportTouch(setNarrowPhase(sample(), "ifclite"), true);
    expect(touching.settings.reportTouch).toBe(true);
    expect(setNarrowPhase(touching, "ifclite").settings.reportTouch).toBe(true);
    expect(setNarrowPhase(touching, "parry").settings).not.toHaveProperty("reportTouch");
    expect(setReportTouch(touching, false).settings).not.toHaveProperty("reportTouch");
  });
});

describe("runBlockedReason", () => {
  it("allows a run with one file and one enabled rule (self check)", () => {
    expect(runBlockedReason(addSelfCheckRule(sample(), "vent"))).toBeNull();
  });

  it("explains what's missing", () => {
    expect(runBlockedReason(null)).toMatch(/project/);
    expect(runBlockedReason({ ...sample(), files: [] })).toMatch(/at least one IFC/);
    expect(runBlockedReason(sample())).toMatch(/at least one rule/);
    const disabled = toggleRule(addSelfCheckRule(sample(), "vent"), "SELF-vent");
    expect(runBlockedReason(disabled)).toMatch(/enable at least one rule/);
  });

  it("ignores the placeholder file", () => {
    const p = { ...sample(), files: [{ id: "placeholder", path: "" }] };
    expect(runBlockedReason(p)).toMatch(/at least one IFC/);
  });
});

describe("updateCustomRule", () => {
  function twoFiles() {
    const p = sample();
    const withStr = { ...p, files: [...p.files, { id: "str", path: "/a/STR.ifc", discipline: "STR" }] };
    return addCustomRule(withStr, "R1", "vent", "IfcDuct*", "str", "IfcBeam");
  }
  const fields = {
    name: "R1",
    aFileId: "vent",
    aSelector: "IfcDuct*",
    bFileId: "str",
    bSelector: "IfcBeam",
  };

  it("changes name, files and selectors in place", () => {
    const p = addCustomRule(twoFiles(), "R2", "str", "*", "str", "*");
    const res = updateCustomRule(p, "R1", {
      name: "HVAC vs beams",
      aFileId: "str",
      aSelector: " IfcColumn ",
      bFileId: "vent",
      bSelector: "",
    });
    expect(res.error).toBeUndefined();
    const rules = res.project!.rules;
    expect(rules.map((r) => r.name)).toEqual(["HVAC vs beams", "R2"]); // order kept
    expect(customRuleFields(rules[0]!)).toEqual({
      name: "HVAC vs beams",
      aFileId: "str",
      aSelector: "IfcColumn",
      bFileId: "vent",
      bSelector: "*", // empty → *
      aMode: "i",
      bMode: "i",
      aExclude: "",
      bExclude: "",
    });
  });

  it("sets, keeps and clears a side's exclude", () => {
    const set = updateCustomRule(twoFiles(), "R1", { ...fields, aExclude: " IfcSpace " }).project!;
    expect(customRuleFields(set.rules[0]!)).toMatchObject({ aExclude: "IfcSpace", bExclude: "" });
    // Omitted ⇒ kept.
    const kept = updateCustomRule(set, "R1", { ...fields, bSelector: "IfcColumn" }).project!;
    expect(customRuleFields(kept.rules[0]!)?.aExclude).toBe("IfcSpace");
    // Blank ⇒ removed from the saved rule.
    const cleared = updateCustomRule(kept, "R1", { ...fields, aExclude: "  " }).project!;
    expect((cleared.rules[0] as { a: object }).a).not.toHaveProperty("exclude");
  });

  it("changes a side's mode when the form sets it", () => {
    const res = updateCustomRule(twoFiles(), "R1", { ...fields, bMode: "e" });
    expect(customRuleFields(res.project!.rules[0]!)).toMatchObject({ aMode: "i", bMode: "e" });
  });

  it("addCustomRule stores excludes when given", () => {
    const p = addCustomRule(sample(), "X", "vent", "*", "vent", "*", { bExclude: "IfcSpace" });
    expect(customRuleFields(p.rules[0]!)).toMatchObject({ aExclude: "", bExclude: "IfcSpace" });
  });

  it("keeps enabled flag and include/exclude mode", () => {
    let p = toggleRule(twoFiles(), "R1");
    p = { ...p, rules: p.rules.map((r) => ({ ...r, a: { ...(r as { a: object }).a, mode: "e" } })) } as typeof p;
    const res = updateCustomRule(p, "R1", { ...fields, aSelector: "IfcPipe*" });
    const r = res.project!.rules[0]! as { enabled: boolean; a: { mode: string; selector: string } };
    expect(r.enabled).toBe(false);
    expect(r.a.mode).toBe("e");
    expect(r.a.selector).toBe("IfcPipe*");
  });

  it("rejects a name taken by another rule", () => {
    const p = addCustomRule(twoFiles(), "R2", "str", "*", "str", "*");
    expect(updateCustomRule(p, "R1", { ...fields, name: "R2" }).error).toMatch(/already exists/);
  });

  it("rejects empty name and unknown files", () => {
    const p = twoFiles();
    expect(updateCustomRule(p, "R1", { ...fields, name: "  " }).error).toMatch(/empty/);
    expect(updateCustomRule(p, "R1", { ...fields, aFileId: "nope" }).error).toMatch(/side A/);
    expect(updateCustomRule(p, "R1", { ...fields, bFileId: "" }).error).toMatch(/side B/);
  });

  it("refuses to edit preset rules or unknown rules", () => {
    const p = addPresetRule(twoFiles(), "HVACxSTR");
    expect(updateCustomRule(p, "HVACxSTR", fields).error).toMatch(/Preset/);
    expect(updateCustomRule(p, "nope", fields).error).toMatch(/not found/);
    expect(customRuleFields(p.rules.find((r) => r.name === "HVACxSTR")!)).toBeNull();
  });
});
