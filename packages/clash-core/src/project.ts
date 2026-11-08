// .clashproj — project file load, save, validate, and expansion to
// engine clash rules. Schema matches SPEC.md §7.
//
// Design notes:
//   - The project file is the user-facing artefact. Hand-editable JSON.
//   - The engine speaks a different language ("clash-set JSON" — see
//     types.ts/ClashRule). expandProjectToRules() is the bridge.
//   - We validate aggressively at load time so errors are flagged early,
//     not buried inside the engine binary.
//   - Schema versioning is set up from day one. Today's version is `1`.
//     When we break the schema, bump `version` and add a migration in
//     `migrateProject()`.
//
// Presets ARE resolved here as of M3. `expandProjectToRules` accepts an
// optional preset map (defaults to the one in `presets/`). A rule with
// `preset: "HVACxSTR"` is expanded by looking the preset up in the map
// and finding all project files whose `discipline` matches each side.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PresetDefinition } from "./presets.js";
import { loadPresets, presetsApplicableTo } from "./presets.js";
import type { ClashRule, SelectionGroup } from "./types.js";
import { validateSettings, type ProjectSettings } from "./settings.js";

export type { ProjectSettings };

export const CURRENT_PROJECT_SCHEMA_VERSION = 1 as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Project {
  /** Schema version. Always `1` for now. */
  version: 1;
  /** Free-text project name. Shown in reports. */
  name: string;
  /** ISO-8601 timestamp; informational only. */
  createdAt: string;
  /** IFCs referenced by this project. */
  files: ProjectFile[];
  /** Clash rules to evaluate. */
  rules: ProjectRule[];
  /** Detection thresholds. */
  settings: ProjectSettings;
  /** Optional snapshot of the last run; written by `clashtester run`. */
  lastResults?: ProjectLastResults;
}

export interface ProjectFile {
  /** Stable id used by `ProjectRule.a/b.fileId`. Hand-editable. */
  id: string;
  /**
   * Path to the IFC. Stored as-given. When loading, relative paths are
   * resolved against the project file's containing directory.
   */
  path: string;
  /** Optional discipline tag (e.g. `"ARCH"`, `"STR"`, `"MEP"`). */
  discipline?: string;
  /**
   * Per-file translation override in metres. Default `[0, 0, 0]`.
   * Edge cases only — see SPEC.md §4.
   */
  translation?: [number, number, number];
}

export type ProjectRule = ProjectRulePreset | ProjectRuleCustom;

/** A rule that references a preset by name (preset machinery lands in M3). */
export interface ProjectRulePreset {
  name: string;
  preset: string;
  enabled?: boolean;
}

/** A fully-specified custom rule. */
export interface ProjectRuleCustom {
  name: string;
  preset?: null;
  enabled?: boolean;
  a: ProjectRuleSide;
  b: ProjectRuleSide;
}

export interface ProjectRuleSide {
  /** References `ProjectFile.id`. */
  fileId: string;
  /** Selector string (see runner types). Optional defaults to `*`. */
  selector?: string;
  /** Include (default) or exclude. */
  mode?: "i" | "e";
  /**
   * Selector of elements to drop after `selector`/`mode` picked the side
   * (e.g. `"IfcSpace|IfcOpeningElement"`). Non-empty when present.
   */
  exclude?: string;
}

export interface ProjectLastResults {
  ranAt: string;
  totalClashes: number;
  outputs: {
    bcf?: string;
    json?: string;
    csv?: string;
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Throws `ProjectValidationError` with a list of human-readable messages
 * if anything is structurally wrong with `raw`. Returns the typed `Project`
 * otherwise.
 *
 * Intentionally strict — we'd rather catch a typo in the project file than
 * surface a confusing error from the engine binary.
 */
export class ProjectValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid project file:\n  - ${issues.join("\n  - ")}`);
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

export function validateProject(raw: unknown): Project {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectValidationError(["root must be a JSON object"]);
  }
  const r = raw as Record<string, unknown>;

  // version
  if (r.version !== CURRENT_PROJECT_SCHEMA_VERSION) {
    issues.push(
      `version must be ${CURRENT_PROJECT_SCHEMA_VERSION} (got ${JSON.stringify(r.version)})`,
    );
  }

  // name
  if (typeof r.name !== "string" || r.name.length === 0) {
    issues.push("name must be a non-empty string");
  }

  // createdAt — accept any string; we don't parse the date here
  if (typeof r.createdAt !== "string") {
    issues.push("createdAt must be a string (ISO-8601)");
  }

  // files
  const files: ProjectFile[] = [];
  if (!Array.isArray(r.files) || r.files.length === 0) {
    issues.push("files must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [i, f] of (r.files as unknown[]).entries()) {
      if (typeof f !== "object" || f === null) {
        issues.push(`files[${i}] must be an object`);
        continue;
      }
      const fo = f as Record<string, unknown>;
      if (typeof fo.id !== "string" || fo.id.length === 0) {
        issues.push(`files[${i}].id must be a non-empty string`);
        continue;
      }
      if (seen.has(fo.id)) {
        issues.push(`files[${i}].id "${fo.id}" is duplicated`);
      }
      seen.add(fo.id);
      if (typeof fo.path !== "string" || fo.path.length === 0) {
        issues.push(`files[${i}].path must be a non-empty string`);
        continue;
      }
      const file: ProjectFile = { id: fo.id, path: fo.path };
      if (typeof fo.discipline === "string") file.discipline = fo.discipline;
      if (Array.isArray(fo.translation) && fo.translation.length === 3) {
        const t = fo.translation as unknown[];
        if (t.every((n) => typeof n === "number" && Number.isFinite(n))) {
          file.translation = [t[0] as number, t[1] as number, t[2] as number];
        } else {
          issues.push(`files[${i}].translation must be three finite numbers`);
        }
      }
      files.push(file);
    }
  }

  // rules
  const rules: ProjectRule[] = [];
  if (!Array.isArray(r.rules)) {
    issues.push("rules must be an array (may be empty)");
  } else {
    for (const [i, rl] of (r.rules as unknown[]).entries()) {
      if (typeof rl !== "object" || rl === null) {
        issues.push(`rules[${i}] must be an object`);
        continue;
      }
      const ro = rl as Record<string, unknown>;
      if (typeof ro.name !== "string" || ro.name.length === 0) {
        issues.push(`rules[${i}].name must be a non-empty string`);
        continue;
      }
      const enabled = ro.enabled === undefined ? true : ro.enabled === true;
      // Preset-shaped rule
      if (typeof ro.preset === "string") {
        rules.push({ name: ro.name, preset: ro.preset, enabled });
        continue;
      }
      // Custom rule — needs a and b
      const a = validateSide(`rules[${i}].a`, ro.a, files, issues);
      const b = validateSide(`rules[${i}].b`, ro.b, files, issues);
      if (a && b) {
        rules.push({ name: ro.name, preset: null, enabled, a, b });
      }
    }
  }

  // settings (shared with the desktop's live edits — settings.ts)
  const { settings, issues: settingsIssues } = validateSettings(r.settings);
  issues.push(...settingsIssues);

  if (issues.length > 0) {
    throw new ProjectValidationError(issues);
  }

  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: r.name as string,
    createdAt: r.createdAt as string,
    files,
    rules,
    settings,
    // lastResults is optional and not validated structurally for now.
    ...(typeof r.lastResults === "object" && r.lastResults !== null
      ? { lastResults: r.lastResults as ProjectLastResults }
      : {}),
  };
}

function validateSide(
  prefix: string,
  raw: unknown,
  files: ProjectFile[],
  issues: string[],
): ProjectRuleSide | null {
  if (typeof raw !== "object" || raw === null) {
    issues.push(`${prefix} must be an object`);
    return null;
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.fileId !== "string" || s.fileId.length === 0) {
    issues.push(`${prefix}.fileId must be a non-empty string`);
    return null;
  }
  if (!files.some((f) => f.id === s.fileId)) {
    issues.push(`${prefix}.fileId "${s.fileId}" does not match any files[].id`);
    return null;
  }
  const side: ProjectRuleSide = { fileId: s.fileId };
  if (typeof s.selector === "string") side.selector = s.selector;
  if (s.mode === "i" || s.mode === "e") side.mode = s.mode;
  if (s.exclude !== undefined) {
    if (typeof s.exclude !== "string" || s.exclude.trim().length === 0) {
      issues.push(`${prefix}.exclude must be a non-empty string when present`);
      return null;
    }
    side.exclude = s.exclude;
  }
  return side;
}

// ─── Load / save ──────────────────────────────────────────────────────────────

/**
 * Read a `.clashproj` file from disk and validate it. Relative `path`
 * fields in `files[]` are resolved against the project file's directory
 * so the engine receives absolute paths.
 */
export async function loadProject(filePath: string): Promise<Project> {
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ProjectValidationError([
      `Project file is not valid JSON: ${(e as Error).message}`,
    ]);
  }
  const project = validateProject(parsed);
  const dir = path.dirname(path.resolve(filePath));
  project.files = project.files.map((f) => ({
    ...f,
    path: path.isAbsolute(f.path) ? f.path : path.resolve(dir, f.path),
  }));
  return project;
}

/** Write a project to disk as pretty JSON. */
export async function saveProject(filePath: string, project: Project): Promise<void> {
  // Always re-validate before writing — catches bugs in callers.
  validateProject(project);
  await writeFile(filePath, JSON.stringify(project, null, 2), "utf-8");
}

// ─── Expansion to engine ClashRule[] ──────────────────────────────────────────

/** Optional knobs for `expandProjectToRules`. */
export interface ExpandOptions {
  /**
   * Pre-loaded preset map. Defaults to `loadPresets()` (workspace-default
   * `presets/` folder). Pass a custom map in tests or when presets are
   * embedded elsewhere (e.g. inside a desktop-app bundle).
   */
  presets?: Map<string, PresetDefinition>;
  /**
   * Override the directory `loadPresets()` reads from. Ignored when
   * `presets` is provided. Useful for tests.
   */
  presetsDir?: string;
  /**
   * Called when a rule cannot be expanded — preset missing, no files
   * matching the side's discipline, etc. Defaults to `console.warn`.
   * Tests use this to capture the messages.
   */
  onWarning?: (message: string) => void;
}

/**
 * Convert a `Project` into the `ClashRule[]` shape the engine accepts.
 *
 * - Disabled rules are dropped.
 * - Preset rules are expanded via the preset library: side selectors come
 *   from the preset, and all project files with a matching discipline
 *   become the SelectionGroups on that side.
 * - File paths are looked up via `fileId` and converted to absolute paths
 *   (which `loadProject` already does).
 * - Per-file `translation` from `files[]` is attached to every selection
 *   group referring to that file.
 */
export function expandProjectToRules(
  project: Project,
  options: ExpandOptions = {},
): ClashRule[] {
  const filesById = new Map(project.files.map((f) => [f.id, f]));
  const rules: ClashRule[] = [];
  const warn = options.onWarning ?? ((m: string) => console.warn(m));

  // Lazy preset load so callers that have no preset rules pay nothing.
  let presetMap: Map<string, PresetDefinition> | null = options.presets ?? null;
  const ensurePresets = (): Map<string, PresetDefinition> => {
    if (!presetMap) presetMap = loadPresets({ dir: options.presetsDir });
    return presetMap;
  };

  for (const rl of project.rules) {
    if (rl.enabled === false) continue;
    if (isPresetRule(rl)) {
      const preset = ensurePresets().get(rl.preset);
      if (!preset) {
        warn(
          `Skipping rule "${rl.name}" — preset "${rl.preset}" not found in presets/. Run \`clashtester run\` from the workspace root, or check the spelling.`,
        );
        continue;
      }
      const aGroups = filesForDiscipline(
        project.files,
        preset.sideA.discipline,
        preset.sideA.selector,
      );
      const bGroups = filesForDiscipline(
        project.files,
        preset.sideB.discipline,
        preset.sideB.selector,
      );
      if (aGroups.length === 0 || bGroups.length === 0) {
        warn(
          `Skipping rule "${rl.name}" (preset "${preset.name}") — no project files with discipline ` +
            `${aGroups.length === 0 ? `"${preset.sideA.discipline}" (side A)` : `"${preset.sideB.discipline}" (side B)`}. ` +
            `Tag a file's "discipline" field to enable this rule.`,
        );
        continue;
      }
      rules.push({ name: rl.name, a: aGroups, b: bGroups });
      continue;
    }
    const a = sideToSelectionGroup(rl.a, filesById, rl.name, "a");
    const b = sideToSelectionGroup(rl.b, filesById, rl.name, "b");
    rules.push({ name: rl.name, a: [a], b: [b] });
  }

  return rules;
}

// ─── Auto-add presets (suggestion + mutation helpers) ────────────────────────

/**
 * Collect the distinct, defined disciplines on the project's files.
 * Files tagged `"UNKNOWN"` are excluded — an UNKNOWN tag means the
 * discipline hasn't been confirmed, so it shouldn't drive auto-add
 * decisions. The placeholder file (used in fresh MCP states) is also
 * skipped.
 */
function projectDisciplineSet(project: Project): Set<string> {
  const out = new Set<string>();
  for (const f of project.files) {
    if (f.id === "placeholder") continue;
    if (!f.discipline) continue;
    if (f.discipline === "UNKNOWN") continue;
    out.add(f.discipline);
  }
  return out;
}

/**
 * Return every shipped preset whose disciplines are both present in
 * the project. Pure — does not mutate the project. Filters out
 * presets the project already has by name (so the suggestion list
 * doesn't include duplicates).
 */
export function suggestPresetsForProject(
  project: Project,
  options: { presetsDir?: string; presets?: Map<string, PresetDefinition> } = {},
): PresetDefinition[] {
  const map = options.presets ?? loadPresets({ dir: options.presetsDir });
  const disciplines = projectDisciplineSet(project);
  const applicable = presetsApplicableTo(disciplines, map);
  const existingNames = new Set(project.rules.map((r) => r.name));
  return applicable.filter((p) => !existingNames.has(p.name));
}

/** Result of `autoAddPresets`. */
export interface AutoAddPresetsResult {
  /** The new project with added rules. Same identity as input if nothing changed. */
  project: Project;
  /** Names of presets that were added. Empty when no changes. */
  added: string[];
  /**
   * Disciplines present on the project at the time of the call. Useful
   * for explaining to the user *why* nothing was added when `added`
   * is empty.
   */
  disciplinesSeen: string[];
}

/**
 * Auto-add every shipped preset whose disciplines are both present in
 * the project and which isn't already a rule (by name). Pure — returns
 * a new Project; the input is not mutated.
 *
 * Added rules are appended in deterministic order (preset name sort)
 * so two calls on the same project produce the same result.
 */
export function autoAddPresets(
  project: Project,
  options: { presetsDir?: string; presets?: Map<string, PresetDefinition> } = {},
): AutoAddPresetsResult {
  const suggestions = suggestPresetsForProject(project, options);
  if (suggestions.length === 0) {
    return {
      project,
      added: [],
      disciplinesSeen: [...projectDisciplineSet(project)].sort(),
    };
  }
  // Sort by name for deterministic ordering.
  const sorted = [...suggestions].sort((a, b) => a.name.localeCompare(b.name));
  const newRules: ProjectRule[] = sorted.map((p) => ({
    name: p.name,
    preset: p.name,
    enabled: true,
  }));
  return {
    project: { ...project, rules: [...project.rules, ...newRules] },
    added: sorted.map((p) => p.name),
    disciplinesSeen: [...projectDisciplineSet(project)].sort(),
  };
}

/** All project files whose discipline matches; mapped to SelectionGroups. */
function filesForDiscipline(
  files: ProjectFile[],
  discipline: string,
  selector: string,
): SelectionGroup[] {
  return files
    .filter((f) => f.discipline === discipline)
    .map((f) => {
      const g: SelectionGroup = { file: f.path, selector, mode: "i" };
      if (f.translation) g.translation = f.translation;
      return g;
    });
}

function isPresetRule(r: ProjectRule): r is ProjectRulePreset {
  return typeof (r as ProjectRulePreset).preset === "string";
}

function sideToSelectionGroup(
  side: ProjectRuleSide,
  filesById: Map<string, ProjectFile>,
  ruleName: string,
  which: "a" | "b",
): SelectionGroup {
  const file = filesById.get(side.fileId);
  if (!file) {
    // Shouldn't happen — validation catches this. Defensive nonetheless.
    throw new Error(
      `expandProjectToRules: rule "${ruleName}" side ${which} fileId "${side.fileId}" not found`,
    );
  }
  const group: SelectionGroup = {
    file: file.path,
    selector: side.selector ?? "*",
    mode: side.mode ?? "i",
  };
  if (side.exclude) {
    group.exclude = side.exclude;
  }
  if (file.translation) {
    group.translation = file.translation;
  }
  return group;
}
