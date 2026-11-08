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
//
// Types, validation, rule expansion and auto-add live in ./project/; this
// file loads and saves, and is the public API.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProjectSettings } from "./settings.js";
import type { Project } from "./project/projectTypes.js";
import { ProjectValidationError, validateProject } from "./project/validate.js";

export type { ProjectSettings };
export {
  CURRENT_PROJECT_SCHEMA_VERSION,
  type Project,
  type ProjectFile,
  type ProjectLastResults,
  type ProjectRule,
  type ProjectRuleCustom,
  type ProjectRulePreset,
  type ProjectRuleSide,
} from "./project/projectTypes.js";
export { ProjectValidationError, validateProject } from "./project/validate.js";
export { expandProjectToRules, type ExpandOptions } from "./project/expand.js";
export {
  autoAddPresets,
  suggestPresetsForProject,
  type AutoAddPresetsResult,
} from "./project/autoAdd.js";

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
