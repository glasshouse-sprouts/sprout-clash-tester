// Desktop MCP ops (SPEC §13d, phase 1). Pure: `(state, args) → { state,
// result }`, so they are tested without Electron or React. App.tsx runs
// them against the live AppState when the main process forwards a tool
// call; `ui_run` (async, side effects) is handled in App.tsx using
// `runBlockedReason` and `runSummary` from here.
//
// Errors are thrown as `Error` with a message meant for the agent — it
// becomes the MCP tool error.

import { summariseGroups } from "@clash-tester/core/grouping";
import type { ProjectRule } from "@clash-tester/core/types";
import { customRuleFields, noSelection, type AppState, type LastRun, type View } from "./state";

export interface OpResult {
  state: AppState;
  result: unknown;
}

type Args = Record<string, unknown>;

export const PURE_OPS = [
  "ui_get_state",
  "ui_get_results",
  "ui_show_view",
  "ui_select_clash",
  "ui_select_group",
] as const;
export type PureOp = (typeof PURE_OPS)[number];

export function isPureOp(op: string): op is PureOp {
  return (PURE_OPS as readonly string[]).includes(op);
}

export function applyUiOp(state: AppState, op: PureOp, args: Args): OpResult {
  switch (op) {
    case "ui_get_state":
      return { state, result: describeState(state) };
    case "ui_get_results":
      return { state, result: resultsPage(state, args) };
    case "ui_show_view":
      return showView(state, args);
    case "ui_select_clash":
      return selectClash(state, args);
    case "ui_select_group":
      return selectGroup(state, args);
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

function clashNumber(c: LastRun["clashes"][number], index: number): number {
  return c.number ?? index + 1;
}

function describeRule(r: ProjectRule) {
  const enabled = r.enabled !== false;
  const fields = customRuleFields(r);
  if (!fields) return { name: r.name, kind: "preset", preset: (r as { preset: string }).preset, enabled };
  const raw = r as { a: { exclude?: string; mode?: string }; b: { exclude?: string; mode?: string } };
  return {
    name: r.name,
    kind: fields.aFileId === fields.bFileId ? "self check" : "custom",
    enabled,
    a: { fileId: fields.aFileId, selector: fields.aSelector, mode: raw.a.mode ?? "i", exclude: raw.a.exclude ?? null },
    b: { fileId: fields.bFileId, selector: fields.bSelector, mode: raw.b.mode ?? "i", exclude: raw.b.exclude ?? null },
  };
}

/** Summary of a run — `ui_get_state.lastRun` and the `ui_run` answer. */
export function runSummary(lr: LastRun) {
  return {
    totalClashes: lr.totalClashes,
    durationMs: lr.durationMs,
    perRule: lr.perRule,
    groups: summariseGroups(lr.groups),
    warnings: lr.warnings.length,
    openingCuts: lr.openingCuts ?? null,
    outputs: lr.outputs,
  };
}

export function describeState(s: AppState) {
  const p = s.project;
  return {
    project: p
      ? {
          name: p.name,
          path: s.projectPath,
          unsavedChanges: s.dirty,
          files: p.files
            .filter((f) => f.id !== "placeholder")
            .map((f) => ({ id: f.id, discipline: f.discipline ?? null, path: f.path })),
          rules: p.rules.map(describeRule),
          settings: p.settings,
        }
      : null,
    view: s.view,
    running: s.running,
    progress: s.runProgress
      ? {
          rule: s.runProgress.currentRule,
          totalRules: s.runProgress.totalRules,
          pairs: s.runProgress.pairs,
          elapsedMs: Date.now() - s.runProgress.startedAt,
        }
      : null,
    lastRun: s.lastRun ? runSummary(s.lastRun) : null,
    selection: s.selection,
    error: s.error,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function intArg(args: Args, name: string, fallback: number, min: number, max: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return v;
}

function requireRun(s: AppState): LastRun {
  if (!s.lastRun) throw new Error("No results yet — run the project first (ui_run).");
  return s.lastRun;
}

export function resultsPage(s: AppState, args: Args) {
  const lr = requireRun(s);
  const kind = args.kind ?? "clashes";
  if (kind !== "clashes" && kind !== "groups" && kind !== "warnings") {
    throw new Error('kind must be "clashes", "groups" or "warnings".');
  }
  const offset = intArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intArg(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  const page = <T>(items: readonly T[]) => ({
    kind,
    total: items.length,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  });
  if (kind === "warnings") return page(lr.warnings);
  if (kind === "groups") {
    return page(
      lr.groups.map((g, i) => ({
        number: i + 1,
        key: g.key,
        kind: (g.kind as string) === "element" ? "clashGroup" : g.kind, // pre-T6 results
        title: g.title,
        clashNumbers: g.clashIndices.map((ci) => clashNumber(lr.clashes[ci]!, ci)),
        rules: g.rules,
      })),
    );
  }
  return page(lr.clashes.map((c, i) => ({ ...c, number: clashNumber(c, i) })));
}

// ─── Navigating ───────────────────────────────────────────────────────────────

const VIEWS: readonly View[] = ["files", "rules", "results"];

function showView(s: AppState, args: Args): OpResult {
  if (!s.project) throw new Error("No project is open in Clash Tester.");
  const view = args.view;
  if (typeof view !== "string" || !(VIEWS as readonly string[]).includes(view)) {
    throw new Error('view must be "files", "rules" or "results".');
  }
  return { state: { ...s, view: view as View }, result: `Showing the ${view} view.` };
}

function selectClash(s: AppState, args: Args): OpResult {
  const lr = requireRun(s);
  const n = args.number;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error("number must be an integer.");
  const index = lr.clashes.findIndex((c, i) => clashNumber(c, i) === n);
  if (index < 0) throw new Error(`No clash number ${n} — this run has ${lr.clashes.length} clashes.`);
  const clash = lr.clashes[index]!;
  const groups = lr.groups.filter((g) => g.clashIndices.includes(index)).map((g) => g.key);
  return {
    state: { ...s, view: "results", selection: { ...noSelection, clashNumber: n } },
    result: { shown: `Clash ${n} is highlighted with its detail open.`, clash: { ...clash, number: n }, groups },
  };
}

function selectGroup(s: AppState, args: Args): OpResult {
  const lr = requireRun(s);
  let index = -1;
  if (typeof args.key === "string") {
    index = lr.groups.findIndex((g) => g.key === args.key);
    if (index < 0) throw new Error(`No group with key "${args.key}". List them with ui_get_results kind=groups.`);
  } else if (typeof args.number === "number" && Number.isInteger(args.number)) {
    index = args.number - 1;
    if (index < 0 || index >= lr.groups.length) {
      throw new Error(`No group number ${args.number} — this run has ${lr.groups.length} groups.`);
    }
  } else {
    throw new Error("Pass key (string) or number (integer).");
  }
  const g = lr.groups[index]!;
  return {
    state: { ...s, view: "results", selection: { ...noSelection, groupKey: g.key } },
    result: {
      shown: `Group ${index + 1} is highlighted with its ${g.clashIndices.length} clash(es).`,
      group: {
        number: index + 1,
        key: g.key,
        title: g.title,
        clashNumbers: g.clashIndices.map((ci) => clashNumber(lr.clashes[ci]!, ci)),
      },
    },
  };
}
