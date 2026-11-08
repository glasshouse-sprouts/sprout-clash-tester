// Desktop MCP ops (docs/MCP.md#desktop-live-ui--clash-tester-ui) — pure, no Electron/React.

import { describe, expect, it } from "vitest";
import type { Project } from "@clash-tester/core/types";
import { applyUiOp, describeState, isPureOp, resultsPage, runSummary } from "./mcpOps";
import { initialAppState, type AppState, type LastRun } from "./state";

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
        name: "SELF-ark",
        preset: null,
        enabled: false,
        a: { fileId: "ark", selector: "*", mode: "i", exclude: "IfcSpace" },
        b: { fileId: "ark", selector: "*", mode: "i", exclude: "IfcSpace" },
      },
    ],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

function clash(number: number | undefined, a: string, b: string): LastRun["clashes"][number] {
  return {
    ...(number === undefined ? {} : { number }),
    rule: "STRxARCH",
    fileA: "STR.ifc",
    fileB: "ARK.ifc",
    ifcTypeA: "IfcBeam",
    ifcTypeB: "IfcWall",
    guidA: a,
    guidB: b,
    position: [0, 0, 0],
    mode: "intersection",
    depthMetres: 0.01,
    gapMetres: null,
    aabbOverlapExtents: null,
    aabbOverlapVolume: null,
  };
}

function lastRun(): LastRun {
  return {
    totalClashes: 3,
    durationMs: 120,
    perRule: [{ name: "STRxARCH", clashes: 3 }],
    warnings: [{ kind: "x", message: "w", files: [] }],
    clashes: [clash(1, "B1", "W1"), clash(2, "B1", "W2"), clash(3, "B9", "W9")],
    groups: [
      {
        key: "clashgroup:B1",
        kind: "clashGroup",
        title: "IfcBeam clashes with 2 elements (IfcWall ×2) [STRxARCH]",
        element: { guid: "B1", ifcType: "IfcBeam", file: "STR.ifc" },
        clashIndices: [0, 1],
        clashKeys: ["B1|W1", "B1|W2"],
        pairCount: 2,
        rules: ["STRxARCH"],
        position: [0, 0, 0],
        maxDepthMetres: 0.01,
        minGapMetres: null,
        aabbOverlapVolume: null,
      },
      {
        key: "pair:B9|W9",
        kind: "pair",
        title: "IfcBeam × IfcWall",
        element: null,
        clashIndices: [2],
        clashKeys: ["B9|W9"],
        pairCount: 1,
        rules: ["STRxARCH"],
        position: [0, 0, 0],
        maxDepthMetres: 0.01,
        minGapMetres: null,
        aabbOverlapVolume: null,
      },
    ],
    outputs: { bcf: "/o/report.bcf", json: "/o/clashes.json", csv: "/o/clashes.csv" },
  };
}

const withProject = (): AppState => ({ ...initialAppState, project: project(), projectPath: "/p/demo.clashproj" });
const withRun = (): AppState => ({ ...withProject(), lastRun: lastRun() });

describe("isPureOp", () => {
  it("knows the phase-1 renderer ops; ui_run and unknown ops are not pure", () => {
    expect(isPureOp("ui_select_clash")).toBe(true);
    expect(isPureOp("ui_run")).toBe(false);
    expect(isPureOp("ui_nope")).toBe(false);
  });
});

describe("ui_get_state", () => {
  it("reports the open project, rules (incl. kind + exclude), view and selection", () => {
    const d = describeState({ ...withRun(), dirty: true, selection: { clashNumber: 2, groupKey: null } });
    expect(d.project).toMatchObject({ name: "Demo", path: "/p/demo.clashproj", unsavedChanges: true });
    expect(d.project!.files.map((f) => f.id)).toEqual(["ark", "str"]);
    expect(d.project!.rules[0]).toEqual({ name: "STRxARCH", kind: "preset", preset: "STRxARCH", enabled: true });
    expect(d.project!.rules[1]).toMatchObject({ kind: "self check", enabled: false, a: { exclude: "IfcSpace" } });
    expect(d.lastRun).toMatchObject({ totalClashes: 3, groups: "2 groups (1 clash group, 1 pair)" });
    expect(d.selection).toEqual({ clashNumber: 2, groupKey: null });
    expect(d.view).toBe("files");
  });

  it("works with nothing open and hides the placeholder file", () => {
    expect(describeState(initialAppState).project).toBeNull();
    const p = { ...project(), files: [{ id: "placeholder", path: "/nonexistent/placeholder.ifc" }] };
    expect(describeState({ ...initialAppState, project: p }).project!.files).toEqual([]);
  });

  it("does not change state", () => {
    const s = withRun();
    expect(applyUiOp(s, "ui_get_state", {}).state).toBe(s);
  });
});

describe("ui_get_results", () => {
  it("pages clashes with their numbers (default kind)", () => {
    const r = resultsPage(withRun(), { offset: 1, limit: 1 }) as { total: number; items: { number: number }[] };
    expect(r.total).toBe(3);
    expect(r.items.map((c) => c.number)).toEqual([2]);
  });

  it("falls back to index + 1 for clashes without numbers", () => {
    const s = withRun();
    s.lastRun!.clashes = s.lastRun!.clashes.map(({ number: _n, ...c }) => c);
    const r = resultsPage(s, {}) as { items: { number: number }[] };
    expect(r.items.map((c) => c.number)).toEqual([1, 2, 3]);
  });

  it("lists groups with number, key and clash numbers; maps old 'element' kind", () => {
    const s = withRun();
    (s.lastRun!.groups[0] as { kind: string }).kind = "element";
    const r = resultsPage(s, { kind: "groups" }) as { items: unknown[] };
    expect(r.items[0]).toMatchObject({ number: 1, key: "clashgroup:B1", kind: "clashGroup", clashNumbers: [1, 2] });
  });

  it("lists warnings; rejects bad args and a missing run", () => {
    expect(resultsPage(withRun(), { kind: "warnings" })).toMatchObject({ total: 1 });
    expect(() => resultsPage(withRun(), { kind: "nope" })).toThrow(/kind must be/);
    expect(() => resultsPage(withRun(), { limit: 0 })).toThrow(/limit must be/);
    expect(() => resultsPage(withRun(), { limit: 501 })).toThrow(/limit must be/);
    expect(() => resultsPage(withProject(), {})).toThrow(/No results yet/);
  });
});

describe("ui_show_view", () => {
  it("switches view", () => {
    expect(applyUiOp(withProject(), "ui_show_view", { view: "rules" }).state.view).toBe("rules");
  });

  it("rejects bad views and no project", () => {
    expect(() => applyUiOp(withProject(), "ui_show_view", { view: "x" })).toThrow(/view must be/);
    expect(() => applyUiOp(initialAppState, "ui_show_view", { view: "rules" })).toThrow(/No project/);
  });
});

describe("ui_select_clash", () => {
  it("selects by number, switches to results, reports its groups", () => {
    const { state, result } = applyUiOp(withRun(), "ui_select_clash", { number: 2 });
    expect(state.view).toBe("results");
    expect(state.selection).toEqual({ clashNumber: 2, groupKey: null });
    expect(result).toMatchObject({ clash: { number: 2, guidB: "W2" }, groups: ["clashgroup:B1"] });
  });

  it("clears a selected group", () => {
    const s = { ...withRun(), selection: { clashNumber: null, groupKey: "pair:B9|W9" } };
    expect(applyUiOp(s, "ui_select_clash", { number: 3 }).state.selection.groupKey).toBeNull();
  });

  it("rejects unknown numbers, bad args and no run", () => {
    expect(() => applyUiOp(withRun(), "ui_select_clash", { number: 9 })).toThrow(/No clash number 9 — this run has 3/);
    expect(() => applyUiOp(withRun(), "ui_select_clash", { number: "2" })).toThrow(/integer/);
    expect(() => applyUiOp(withProject(), "ui_select_clash", { number: 1 })).toThrow(/No results/);
  });
});

describe("ui_select_group", () => {
  it("selects by key or by Groups-table number", () => {
    const byKey = applyUiOp(withRun(), "ui_select_group", { key: "pair:B9|W9" });
    expect(byKey.state.selection).toEqual({ clashNumber: null, groupKey: "pair:B9|W9" });
    expect(byKey.result).toMatchObject({ group: { number: 2, clashNumbers: [3] } });
    const byNumber = applyUiOp(withRun(), "ui_select_group", { number: 1 });
    expect(byNumber.state.selection.groupKey).toBe("clashgroup:B1");
    expect(byNumber.state.view).toBe("results");
  });

  it("rejects unknown key / number and missing args", () => {
    expect(() => applyUiOp(withRun(), "ui_select_group", { key: "nope" })).toThrow(/No group with key/);
    expect(() => applyUiOp(withRun(), "ui_select_group", { number: 3 })).toThrow(/No group number 3/);
    expect(() => applyUiOp(withRun(), "ui_select_group", {})).toThrow(/Pass key/);
  });
});

describe("runSummary (ui_run answer)", () => {
  it("summarises totals, groups and outputs", () => {
    expect(runSummary(lastRun())).toEqual({
      totalClashes: 3,
      durationMs: 120,
      perRule: [{ name: "STRxARCH", clashes: 3 }],
      groups: "2 groups (1 clash group, 1 pair)",
      warnings: 1,
      openingCuts: null,
      outputs: { bcf: "/o/report.bcf", json: "/o/clashes.json", csv: "/o/clashes.csv" },
    });
  });

  it("passes the run's opening cuts through", () => {
    const openingCuts = { hostsCut: 2, openings: 3, failed: ["W1"], notCut: ["O7"] };
    expect(runSummary({ ...lastRun(), openingCuts }).openingCuts).toEqual(openingCuts);
  });
});
