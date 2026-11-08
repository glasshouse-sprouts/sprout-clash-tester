// Renderer state types + small pure helpers.
//
// Pulled out so they can be unit-tested without React or Electron.

// Browser-safe sub-path import: only pulls in the pure discipline
// helper, not the runner (which uses node:child_process and crashes
// the renderer if accidentally bundled). See clash-core's package.json
// `exports` map for the sub-paths we expose.
import { inferDisciplineFromFilename } from "@clash-tester/core/discipline";
import { SELF_CHECK_DEFAULT_EXCLUDE, type OpeningCuts } from "@clash-tester/core/types";
import type {
  ClashGroup,
  Project,
  ProjectFile,
  ProjectRule,
  ProjectRuleCustom,
  ProjectRulePreset,
} from "@clash-tester/core/types";
import type { RunProgress } from "./progress";

/** Which side panel is showing. */
export type View = "files" | "rules" | "results";

/** What we know about the currently loaded project. */
export interface AppState {
  /** Absolute path of the .clashproj on disk, or null when unsaved. */
  projectPath: string | null;
  project: Project | null;
  view: View;
  /** Dirty marker — true if project has unsaved edits. */
  dirty: boolean;
  /** Last run's structured result, if any. */
  lastRun: LastRun | null;
  /** Whether a run is currently in progress (Run button disabled). */
  running: boolean;
  /**
   * Live progress for the active run. Reset to `null` when not running.
   * Populated by the engine-progress stream — see `progress.ts`.
   */
  runProgress: RunProgress | null;
  /** Toast-style error message; null when no current error. */
  error: string | null;
  /**
   * What the user (or the desktop MCP) has picked in the Results view.
   * Clicks and `ui_select_*` tools set the same state, so `ui_get_state`
   * reports what is on screen (SPEC §13d).
   */
  selection: Selection;
  /** Last AI edit, for the "AI changed … — Undo" notice. */
  aiUndo: AiUndo | null;
}

export interface Selection {
  /** Clash number (T2) whose row is highlighted and detail open. */
  clashNumber: number | null;
  /** Key of the highlighted group; its clashes are highlighted too. */
  groupKey: string | null;
}

export const noSelection: Selection = { clashNumber: null, groupKey: null };

/**
 * One-step undo for an edit made by the desktop MCP (SPEC §13d phase 2).
 * Undo only applies while the project is still exactly `after` (same
 * object) — once the user edits further, the snapshot is stale.
 */
export interface AiUndo {
  /** What the AI changed, e.g. "added self check SELF-ark". */
  label: string;
  /** Null when the AI's edit created the project (first added file). */
  before: Project | null;
  dirtyBefore: boolean;
  after: Project;
}

/** Preset rules offered in the Rules view (and to `ui_add_preset_rule`). */
export const PRESET_NAMES = [
  // Services vs structure
  "MEPxSTR",
  "HVACxSTR",
  "ELECxSTR",
  "FIRExSTR",
  // Services vs architecture
  "HVACxARCH",
  "MEPxARCH",
  "ELECxARCH",
  "FIRExARCH",
  // Service vs service
  "HVACxMEP",
  "ELECxMEP",
  "FIRExMEP",
  // Shell / cross-discipline
  "STRxARCH",
  "STAIRxSTR",
] as const;

export interface LastRun {
  totalClashes: number;
  durationMs: number;
  perRule: {
    name: string;
    clashes: number;
    skippedByRelations?: number;
    /** ifc-lite narrow phase only (SPEC §13g). */
    touchCount?: number;
    unconfirmedCount?: number;
  }[];
  warnings: { kind: string; message: string; files: string[] }[];
  /** Openings cut out of their hosts (SPEC §13f); absent in older results. */
  openingCuts?: OpeningCuts;
  clashes: {
    /** 1-based clash number = BCF title prefix (absent in older results). */
    number?: number;
    rule: string;
    fileA: string;
    fileB: string;
    ifcTypeA: string;
    ifcTypeB: string;
    guidA: string;
    guidB: string;
    position: [number, number, number];
    mode: "intersection" | "clearance" | "";
    depthMetres: number | null;
    gapMetres: number | null;
    aabbOverlapExtents: [number, number, number] | null;
    aabbOverlapVolume: number | null;
    /** Bounding-box similarity 0..1; near 1 = possible double modelling. */
    aabbMatch?: number | null;
    /** Mesh volumes (m³) and centre distance (m) — double modelling inputs. */
    volumeA?: number | null;
    volumeB?: number | null;
    centroidDistanceMetres?: number | null;
    /** ifc-lite narrow phase only (SPEC §13g). */
    status?: "hard" | "clearance" | "touch" | "unconfirmed";
    distanceKind?: "mesh" | "estimate";
    /** Class from the type object for generic IFC2X3 occurrences (SPEC §6). */
    typeClassA?: string;
    typeClassB?: string;
    predefinedTypeA?: string;
    predefinedTypeB?: string;
  }[];
  /** Clash groups (SPEC §13a/b). Empty for results from older versions. */
  groups: ClashGroup[];
  outputs: { bcf?: string; json?: string; csv?: string };
}

export const initialAppState: AppState = {
  projectPath: null,
  project: null,
  view: "files",
  dirty: false,
  lastRun: null,
  running: false,
  runProgress: null,
  error: null,
  selection: noSelection,
  aiUndo: null,
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

// Inlined rather than imported: the renderer can't import clash-core's
// value side (it pulls in Node APIs). Keep in sync with
// `clash-core/src/project.ts`.
const CURRENT_PROJECT_SCHEMA_VERSION = 1 as const;

/** A new, unsaved project (File → New, or the first dropped/added file). */
export function emptyProject(): Project {
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: "Untitled clash test",
    createdAt: new Date().toISOString(),
    files: [
      {
        id: "placeholder",
        path: "/nonexistent/placeholder.ifc",
        discipline: "UNKNOWN",
      },
    ],
    rules: [],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

export function dropPlaceholderIfRealFiles(p: Project): Project {
  const real = p.files.filter(
    (f) => !(f.id === "placeholder" && f.path === "/nonexistent/placeholder.ifc"),
  );
  if (real.length === 0) return p; // keep placeholder
  return { ...p, files: real };
}


/**
 * Classify a list of dropped paths. Returns which are valid `.ifc` files
 * and which should be reported back to the user as ignored.
 *
 * Used by the drag-and-drop handler in the Files view.
 */
export function classifyDroppedPaths(
  pings: { path: string; isFile: boolean; isIfc: boolean }[],
): { ifcs: string[]; ignored: string[] } {
  const ifcs: string[] = [];
  const ignored: string[] = [];
  for (const p of pings) {
    if (p.isFile && p.isIfc) ifcs.push(p.path);
    else ignored.push(p.path);
  }
  return { ifcs, ignored };
}

/**
 * Generate a unique file id for a new entry — basename without extension,
 * snake-cased, suffixed when colliding.
 */
export function uniqueFileId(project: Project, filePath: string): string {
  const baseRaw = filePath
    .split(/[\\/]/)
    .pop()!
    .replace(/\.ifc$/i, "");
  const base = baseRaw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "model";
  const seen = new Set(project.files.map((f) => f.id));
  if (!seen.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base}-${n}`;
    if (!seen.has(c)) return c;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Append a file entry to a project. Pure — returns a new Project.
 *
 * When the caller passes no discipline, we infer one from the filename
 * (e.g. `HVAC_Building.ifc` → `"HVAC"`). The user can override via the
 * dropdown in the Files view. Filename inference returns `"UNKNOWN"`
 * when no rule matches.
 */
export function addFileToProject(
  project: Project,
  filePath: string,
  discipline?: string,
): Project {
  const id = uniqueFileId(project, filePath);
  const finalDiscipline =
    discipline ?? inferDisciplineFromFilename(filePath);
  const entry: ProjectFile = { id, path: filePath, discipline: finalDiscipline };
  return { ...project, files: [...project.files, entry] };
}

/** Remove a file by id. Pure. */
export function removeFileFromProject(project: Project, id: string): Project {
  return {
    ...project,
    files: project.files.filter((f) => f.id !== id),
    rules: project.rules.filter((r) => !ruleReferencesFile(r, id)),
  };
}

function ruleReferencesFile(rule: ProjectRule, id: string): boolean {
  if (isPresetRule(rule)) return false;
  return rule.a.fileId === id || rule.b.fileId === id;
}

function isPresetRule(r: ProjectRule): r is ProjectRulePreset {
  return typeof (r as ProjectRulePreset).preset === "string";
}

/** Set a file's discipline. Pure. */
export function setFileDiscipline(
  project: Project,
  id: string,
  discipline: string,
): Project {
  return {
    ...project,
    files: project.files.map((f) => (f.id === id ? { ...f, discipline } : f)),
  };
}

/** Add a preset-shaped rule. Pure. */
export function addPresetRule(project: Project, presetName: string): Project {
  const rule: ProjectRulePreset = {
    name: presetName,
    preset: presetName,
    enabled: true,
  };
  return { ...project, rules: [...project.rules, rule] };
}

/** Add a custom-shape rule. Pure. */
export function addCustomRule(
  project: Project,
  name: string,
  aFileId: string,
  aSelector: string,
  bFileId: string,
  bSelector: string,
  excludes: { aExclude?: string; bExclude?: string } = {},
): Project {
  const rule: ProjectRuleCustom = {
    name,
    preset: null,
    enabled: true,
    a: withExclude({ fileId: aFileId, selector: aSelector, mode: "i" }, excludes.aExclude),
    b: withExclude({ fileId: bFileId, selector: bSelector, mode: "i" }, excludes.bExclude),
  };
  return { ...project, rules: [...project.rules, rule] };
}

type RuleSide = ProjectRuleCustom["a"];

/** Set (trimmed) or remove a side's `exclude`; blank removes it. */
function withExclude(side: RuleSide, exclude: string | undefined): RuleSide {
  const { exclude: _old, ...rest } = side;
  const ex = exclude?.trim();
  return ex ? { ...rest, exclude: ex } : rest;
}

/**
 * Why the project can't run yet, or `null` when it can. Needs at least one
 * real file (one is enough for a self check) and one enabled rule. Pure —
 * the text is shown as the Run button's tooltip.
 */
export function runBlockedReason(p: Project | null): string | null {
  if (!p) return "Create or open a project first.";
  const real = p.files.filter((f) => f.id !== "placeholder");
  if (real.length === 0) return "Add at least one IFC file.";
  const enabled = p.rules.filter((r) => r.enabled !== false);
  if (enabled.length === 0) return "Add or enable at least one rule.";
  return null;
}

/** Editable fields of a custom rule. */
export interface CustomRuleFields {
  name: string;
  aFileId: string;
  aSelector: string;
  bFileId: string;
  bSelector: string;
  /** Include (`"i"`) or exclude (`"e"`) mode per side. Omitted = keep. */
  aMode?: "i" | "e";
  bMode?: "i" | "e";
  /** Elements to drop after the selector (SPEC §7). `""` = none. Omitted = keep. */
  aExclude?: string;
  bExclude?: string;
}

/**
 * Replace the custom rule called `oldName` with `fields`. Keeps its
 * position in the list and its enabled flag; each side's mode and
 * exclude are kept unless `fields` sets them (a blank exclude removes
 * it). Returns `{ project }` or `{ error }` (unchanged project) when:
 * the rule doesn't exist or is a preset, the new name is empty or taken
 * by another rule, or a file id is unknown. Empty selectors become `*`.
 */
export function updateCustomRule(
  project: Project,
  oldName: string,
  fields: CustomRuleFields,
): { project: Project; error?: undefined } | { project?: undefined; error: string } {
  const idx = project.rules.findIndex((r) => r.name === oldName);
  if (idx < 0) return { error: `Rule "${oldName}" not found.` };
  const current = project.rules[idx]!;
  if ("preset" in current && typeof current.preset === "string") {
    return { error: "Preset rules can't be edited — add a custom rule instead." };
  }
  const name = fields.name.trim();
  if (!name) return { error: "Name can't be empty." };
  if (name !== oldName && project.rules.some((r) => r.name === name)) {
    return { error: `A rule called "${name}" already exists.` };
  }
  const ids = new Set(project.files.map((f) => f.id));
  if (!ids.has(fields.aFileId)) return { error: "Choose a file for side A." };
  if (!ids.has(fields.bFileId)) return { error: "Choose a file for side B." };
  const cur = current as ProjectRuleCustom;
  const side = (
    old: RuleSide,
    fileId: string,
    selector: string,
    mode: "i" | "e" | undefined,
    exclude: string | undefined,
  ): RuleSide => {
    const s: RuleSide = { ...old, fileId, selector: selector.trim() || "*" };
    if (mode) s.mode = mode;
    return exclude === undefined ? s : withExclude(s, exclude);
  };
  const next: ProjectRuleCustom = {
    ...cur,
    name,
    a: side(cur.a, fields.aFileId, fields.aSelector, fields.aMode, fields.aExclude),
    b: side(cur.b, fields.bFileId, fields.bSelector, fields.bMode, fields.bExclude),
  };
  const rules = [...project.rules];
  rules[idx] = next;
  return { project: { ...project, rules } };
}

/** Read a custom rule's editable fields (for pre-filling an edit form). */
export function customRuleFields(rule: ProjectRule): CustomRuleFields | null {
  if ("preset" in rule && typeof rule.preset === "string") return null;
  const r = rule as ProjectRuleCustom;
  if (!r.a || !r.b) return null;
  return {
    name: r.name,
    aFileId: r.a.fileId,
    aSelector: r.a.selector ?? "*",
    bFileId: r.b.fileId,
    bSelector: r.b.selector ?? "*",
    aMode: r.a.mode ?? "i",
    bMode: r.b.mode ?? "i",
    aExclude: r.a.exclude ?? "",
    bExclude: r.b.exclude ?? "",
  };
}

/**
 * Set BCF export to one topic per clash or per group (SPEC §13c). `"clash"`
 * is the default, so it is stored by removing the setting. Pure.
 */
export function setBcfTopics(project: Project, mode: "clash" | "group"): Project {
  const { bcfTopics: _old, ...rest } = project.settings;
  return { ...project, settings: mode === "group" ? { ...rest, bcfTopics: "group" } : rest };
}

/**
 * Badge text for a group kind. `element` is the pre-2026-10-29 name of
 * `clashGroup` — old clashes.json files still carry it, so both read
 * "Clash group". Unknown kinds are shown as-is. Pure.
 */
export function groupKindLabel(kind: string): string {
  switch (kind) {
    case "duplicate":
      return "double?";
    case "clashGroup":
    case "element":
      return "Clash group";
    case "pair":
      return "pair";
    case "area":
      return "area";
    default:
      return kind;
  }
}

/**
 * Turn the IFC-relation skip on (default, stored by leaving the key out)
 * or off (SPEC §13e). Pure.
 */
export function setSkipRelatedElements(project: Project, on: boolean): Project {
  const { skipRelatedElements: _old, ...rest } = project.settings;
  return { ...project, settings: on ? rest : { ...rest, skipRelatedElements: false } };
}

/**
 * Narrow phase (SPEC §13g): parry is the default, stored by leaving the
 * key out. Back to parry also drops `reportTouch`, which only ifc-lite
 * uses. Pure.
 */
export function setNarrowPhase(project: Project, phase: "parry" | "ifclite"): Project {
  const { narrowPhase: _old, reportTouch, ...rest } = project.settings;
  if (phase === "parry") return { ...project, settings: rest };
  return { ...project, settings: { ...rest, narrowPhase: "ifclite", ...(reportTouch ? { reportTouch } : {}) } };
}

/** ifc-lite: also list touching / unconfirmed pairs (default off). Pure. */
export function setReportTouch(project: Project, on: boolean): Project {
  const { reportTouch: _old, ...rest } = project.settings;
  return { ...project, settings: on ? { ...rest, reportTouch: true } : rest };
}

/** Rule name used for a file's self check. */
export function selfCheckRuleName(fileId: string): string {
  return `SELF-${fileId}`;
}

/**
 * Add a self check for one file: the file tested against itself, all
 * element types. Finds internal clashes and double modelling (SPEC §13b).
 * By default spaces and openings are excluded on both sides
 * (`SELF_CHECK_DEFAULT_EXCLUDE`) — they only make meaningless clashes.
 * No-op (returns the same project) if that file's self check already
 * exists or the file id is unknown. Pure.
 */
export function addSelfCheckRule(
  project: Project,
  fileId: string,
  { ignoreSpacesAndOpenings = true }: { ignoreSpacesAndOpenings?: boolean } = {},
): Project {
  const name = selfCheckRuleName(fileId);
  if (!project.files.some((f) => f.id === fileId)) return project;
  if (project.rules.some((r) => r.name === name)) return project;
  const exclude = ignoreSpacesAndOpenings ? SELF_CHECK_DEFAULT_EXCLUDE : undefined;
  return addCustomRule(project, name, fileId, "*", fileId, "*", {
    aExclude: exclude,
    bExclude: exclude,
  });
}

/** Toggle a rule's enabled flag by name. Pure. */
export function toggleRule(project: Project, name: string): Project {
  return {
    ...project,
    rules: project.rules.map((r) =>
      r.name === name ? { ...r, enabled: r.enabled === false ? true : false } : r,
    ),
  };
}

/** Remove a rule by name. Pure. */
export function removeRule(project: Project, name: string): Project {
  return { ...project, rules: project.rules.filter((r) => r.name !== name) };
}
