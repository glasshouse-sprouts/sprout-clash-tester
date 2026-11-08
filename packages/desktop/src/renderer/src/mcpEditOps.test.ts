// Desktop MCP edit ops (SPEC §13d phase 2) — pure, no Electron/React.

import { describe, expect, it } from "vitest";
import type { Project } from "@clash-tester/core/types";
import {
  addFileChecked,
  applyAutoAddPresets,
  applyEditOp,
  canUndoAiEdit,
  isEditOp,
  undoAiEdit,
} from "./mcpEditOps";
import { customRuleFields, initialAppState, type AppState } from "./state";

function project(): Project {
  return {
    version: 1,
    name: "Demo",
    createdAt: "2026-10-29T00:00:00Z",
    files: [
      { id: "ark", path: "/m/ARK.ifc", discipline: "ARCH" },
      { id: "str", path: "/m/STR.ifc", discipline: "STR" },
    ],
    rules: [
      { name: "STRxARCH", preset: "STRxARCH", enabled: true },
      {
        name: "R1",
        preset: null,
        enabled: true,
        a: { fileId: "str", selector: "IfcBeam", mode: "i" },
        b: { fileId: "ark", selector: "*", mode: "i" },
      },
    ],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

const open = (): AppState => ({ ...initialAppState, project: project(), projectPath: "/p/d.clashproj" });
const edit = (s: AppState, op: Parameters<typeof applyEditOp>[1], args: Record<string, unknown>) =>
  applyEditOp(s, op, args);

describe("guards", () => {
  it("knows the edit ops", () => {
    expect(isEditOp("ui_add_self_check")).toBe(true);
    expect(isEditOp("ui_add_file")).toBe(false); // needs main first
    expect(isEditOp("ui_run")).toBe(false);
  });

  it("refuses without a project and during a run", () => {
    expect(() => edit(initialAppState, "ui_remove_rule", { name: "R1" })).toThrow(/No project is open/);
    expect(() => edit({ ...open(), running: true }, "ui_remove_rule", { name: "R1" })).toThrow(/run is in progress/);
  });
});

describe("every edit is dirty + undoable (exact previous project)", () => {
  it("records the snapshot and Undo restores it, including the dirty flag", () => {
    const s0 = open(); // dirty: false
    const { state: s1, result } = edit(s0, "ui_add_self_check", { fileId: "ark" });
    expect(s1.dirty).toBe(true);
    expect(result).toMatchObject({ changed: "added self check SELF-ark", note: expect.stringMatching(/Undo/) });
    expect(canUndoAiEdit(s1)).toBe(true);
    const s2 = undoAiEdit(s1);
    expect(s2.project).toBe(s0.project);
    expect(s2.dirty).toBe(false);
    expect(s2.aiUndo).toBeNull();
  });

  it("Undo goes stale once the user edits further, and then changes nothing", () => {
    const { state: s1 } = edit(open(), "ui_remove_rule", { name: "R1" });
    const userEdited = { ...s1, project: { ...s1.project!, name: "Renamed by user" } };
    expect(canUndoAiEdit(userEdited)).toBe(false);
    expect(undoAiEdit(userEdited).project!.name).toBe("Renamed by user");
  });

  it("a second AI edit replaces the snapshot (one-step undo)", () => {
    const s0 = open();
    const { state: s1 } = edit(s0, "ui_toggle_rule", { name: "R1" });
    const { state: s2 } = edit(s1, "ui_remove_rule", { name: "STRxARCH" });
    expect(undoAiEdit(s2).project).toBe(s1.project);
  });
});

describe("files", () => {
  const ok = (path: string) => ({ path, isFile: true, isIfc: true });

  it("adds a file with a guessed discipline and drops the placeholder", () => {
    const s = { ...open(), project: { ...project(), files: [{ id: "placeholder", path: "/nonexistent/placeholder.ifc" }], rules: [] } };
    const { state, result } = addFileChecked(s, { path: "/m/VENT.ifc" }, ok("/m/VENT.ifc"));
    expect(state.project!.files.map((f) => f.id)).toEqual(["vent"]);
    expect(result).toMatchObject({ file: { id: "vent", discipline: "HVAC" } });
  });

  it("takes an explicit discipline", () => {
    const { state } = addFileChecked(open(), { path: "/m/x.ifc", discipline: "MEP" }, ok("/m/x.ifc"));
    expect(state.project!.files.at(-1)).toMatchObject({ id: "x", discipline: "MEP" });
  });

  it("starts a new project when none is open; Undo removes it again", () => {
    const { state } = addFileChecked(initialAppState, { path: "/m/ARK.ifc" }, ok("/m/ARK.ifc"));
    expect(state.project!.files.map((f) => f.id)).toEqual(["ark"]);
    expect(state.aiUndo!.label).toBe("started a new project with file ark");
    expect(state.view).toBe("files");
    expect(undoAiEdit(state).project).toBeNull();
  });

  it("rejects missing, non-IFC and duplicate paths", () => {
    expect(() => addFileChecked(open(), { path: "/m/no.ifc" }, { path: "/m/no.ifc", isFile: false, isIfc: true })).toThrow(/No file at/);
    expect(() => addFileChecked(open(), { path: "/m/a.txt" }, { path: "/m/a.txt", isFile: true, isIfc: false })).toThrow(/not an .ifc/);
    expect(() => addFileChecked(open(), { path: "/m/ARK.ifc" }, ok("/m/ARK.ifc"))).toThrow(/already in the project/);
    expect(() => addFileChecked(open(), {}, ok(""))).toThrow(/path must be/);
  });

  it("removes a file and the custom rules using it", () => {
    const { state, result } = edit(open(), "ui_remove_file", { id: "str" });
    expect(state.project!.files.map((f) => f.id)).toEqual(["ark"]);
    expect(result).toMatchObject({ removedRules: ["R1"] });
    expect(() => edit(open(), "ui_remove_file", { id: "nope" })).toThrow(/No file "nope"/);
  });
});

describe("rules", () => {
  it("adds a preset; rejects unknown and duplicate names", () => {
    const { state } = edit(open(), "ui_add_preset_rule", { preset: "HVACxSTR" });
    expect(state.project!.rules.at(-1)).toEqual({ name: "HVACxSTR", preset: "HVACxSTR", enabled: true });
    expect(() => edit(open(), "ui_add_preset_rule", { preset: "NOPE" })).toThrow(/Unknown preset/);
    expect(() => edit(open(), "ui_add_preset_rule", { preset: "STRxARCH" })).toThrow(/already exists/);
  });

  it("adds a self check with the default exclude, or without it", () => {
    const withEx = edit(open(), "ui_add_self_check", { fileId: "ark" }).state.project!.rules.at(-1)!;
    expect(customRuleFields(withEx)).toMatchObject({ aExclude: expect.stringContaining("IfcSpace") });
    const noEx = edit(open(), "ui_add_self_check", { fileId: "ark", ignoreSpacesAndOpenings: false }).state.project!.rules.at(-1)!;
    expect(customRuleFields(noEx)).toMatchObject({ aExclude: "", bExclude: "" });
    expect(() => edit(open(), "ui_add_self_check", { fileId: "x" })).toThrow(/No file "x"/);
    expect(() => edit(open(), "ui_add_self_check", { fileId: "ark", ignoreSpacesAndOpenings: "yes" })).toThrow(/true or false/);
  });

  it("refuses a second self check for the same file", () => {
    const { state } = edit(open(), "ui_add_self_check", { fileId: "ark" });
    expect(() => edit(state, "ui_add_self_check", { fileId: "ark" })).toThrow(/SELF-ark" already exists/);
  });

  it("adds a custom rule with selectors, exclude and mode", () => {
    const { state } = edit(open(), "ui_add_custom_rule", {
      name: "Ducts vs walls",
      a: { fileId: "str", selector: "IfcBeam" },
      b: { fileId: "ark", selector: "IfcWall", exclude: "IfcSpace", mode: "e" },
    });
    expect(customRuleFields(state.project!.rules.at(-1)!)).toEqual({
      name: "Ducts vs walls",
      aFileId: "str",
      aSelector: "IfcBeam",
      bFileId: "ark",
      bSelector: "IfcWall",
      aMode: "i",
      bMode: "e",
      aExclude: "",
      bExclude: "IfcSpace",
    });
  });

  it("validates custom rules like the form does", () => {
    const a = { fileId: "str" };
    expect(() => edit(open(), "ui_add_custom_rule", { name: " ", a, b: a })).toThrow(/name must be/);
    expect(() => edit(open(), "ui_add_custom_rule", { name: "R1", a, b: a })).toThrow(/already exists/);
    expect(() => edit(open(), "ui_add_custom_rule", { name: "X", a, b: { fileId: "nope" } })).toThrow(/No file "nope"/);
    expect(() => edit(open(), "ui_add_custom_rule", { name: "X", a, b: {} })).toThrow(/b.fileId/);
    expect(() => edit(open(), "ui_add_custom_rule", { name: "X", a: { fileId: "str", mode: "x" }, b: a })).toThrow(/mode/);
  });

  it("updates only the given fields of a custom rule; renames; refuses presets", () => {
    const { state } = edit(open(), "ui_update_custom_rule", {
      name: "R1",
      newName: "Beams vs ARK",
      b: { exclude: "IfcSpace" },
    });
    expect(customRuleFields(state.project!.rules[1]!)).toMatchObject({
      name: "Beams vs ARK",
      aSelector: "IfcBeam",
      bExclude: "IfcSpace",
    });
    expect(() => edit(open(), "ui_update_custom_rule", { name: "STRxARCH" })).toThrow(/Preset rules can't be edited/);
    expect(() => edit(open(), "ui_update_custom_rule", { name: "R1", newName: "STRxARCH" })).toThrow(/already exists/);
    expect(() => edit(open(), "ui_update_custom_rule", { name: "nope" })).toThrow(/No rule "nope"/);
  });

  it("toggles, sets enabled explicitly, and reports a no-op without an undo", () => {
    const off = edit(open(), "ui_toggle_rule", { name: "R1" }).state;
    expect(off.project!.rules[1]!.enabled).toBe(false);
    const same = edit(off, "ui_toggle_rule", { name: "R1", enabled: false });
    expect(same.state).toBe(off);
    expect(same.result).toMatchObject({ changed: null });
    expect(edit(off, "ui_toggle_rule", { name: "R1", enabled: true }).state.project!.rules[1]!.enabled).toBe(true);
  });

  it("removes a rule", () => {
    expect(edit(open(), "ui_remove_rule", { name: "R1" }).state.project!.rules.map((r) => r.name)).toEqual(["STRxARCH"]);
    expect(() => edit(open(), "ui_remove_rule", { name: "R9" })).toThrow(/No rule "R9"/);
  });
});

describe("auto-add presets (after main ran it)", () => {
  it("applies the returned project with an undo", () => {
    const next = { ...project(), rules: [...project().rules, { name: "HVACxSTR", preset: "HVACxSTR", enabled: true }] };
    const { state, result } = applyAutoAddPresets(open(), { project: next, added: ["HVACxSTR"], disciplinesSeen: ["ARCH", "STR", "HVAC"] });
    expect(state.project).toBe(next);
    expect(canUndoAiEdit(state)).toBe(true);
    expect(result).toMatchObject({ added: ["HVACxSTR"] });
  });

  it("explains when nothing applies, without changing state", () => {
    const s = open();
    const r = applyAutoAddPresets(s, { project: s.project!, added: [], disciplinesSeen: ["ARCH"] });
    expect(r.state).toBe(s);
    expect(r.result).toMatchObject({ changed: null, reason: expect.stringMatching(/only 1 discipline/) });
  });
});

describe("settings", () => {
  it("merges given fields and validates with the .clashproj messages", () => {
    const { state } = edit(open(), "ui_set_settings", { toleranceMeters: 0.05, grouping: { minElementClashes: 3 } });
    expect(state.project!.settings).toEqual({
      toleranceMeters: 0.05,
      minPenetrationMeters: 0.005,
      grouping: { minElementClashes: 3 },
    });
    expect(() => edit(open(), "ui_set_settings", { toleranceMeters: -1 })).toThrow("settings.toleranceMeters must be >= 0");
    expect(() => edit(open(), "ui_set_settings", { grouping: { minElementClashes: 1 } })).toThrow(/minElementClashes must be an integer >= 2/);
    expect(() => edit(open(), "ui_set_settings", { bcfTopics: "x" })).toThrow(/bcfTopics must be/);
    expect(() => edit(open(), "ui_set_settings", {})).toThrow(/Pass at least one/);
  });

  it("turns the IFC-relation skip off and on (on = key left out)", () => {
    const off = edit(open(), "ui_set_settings", { skipRelatedElements: false }).state;
    expect(off.project!.settings.skipRelatedElements).toBe(false);
    expect(edit(off, "ui_set_settings", { skipRelatedElements: true }).state.project!.settings).not.toHaveProperty("skipRelatedElements");
    expect(() => edit(open(), "ui_set_settings", { skipRelatedElements: "x" })).toThrow(/skipRelatedElements must be true or false/);
  });

  it("sets the narrow phase and touch listing; defaults leave the keys out (SPEC §13g)", () => {
    const on = edit(open(), "ui_set_settings", { narrowPhase: "ifclite", reportTouch: true }).state;
    expect(on.project!.settings.narrowPhase).toBe("ifclite");
    expect(on.project!.settings.reportTouch).toBe(true);
    const off = edit(on, "ui_set_settings", { narrowPhase: "parry", reportTouch: false }).state;
    expect(off.project!.settings).not.toHaveProperty("narrowPhase");
    expect(off.project!.settings).not.toHaveProperty("reportTouch");
    expect(() => edit(open(), "ui_set_settings", { narrowPhase: "fast" })).toThrow(/narrowPhase must be/);
  });

  it("stores bcfTopics group, and per clash by leaving the key out", () => {
    const g = edit(open(), "ui_set_settings", { bcfTopics: "group" }).state;
    expect(g.project!.settings.bcfTopics).toBe("group");
    expect(edit(g, "ui_set_settings", { bcfTopics: "clash" }).state.project!.settings).not.toHaveProperty("bcfTopics");
  });
});
