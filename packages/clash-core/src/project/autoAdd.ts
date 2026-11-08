// Auto-add presets: suggest and add every shipped preset whose two
// disciplines are both on the project's files.

import type { PresetDefinition } from "../presets.js";
import { loadPresets, presetsApplicableTo } from "../presets.js";
import type { Project, ProjectRule } from "./projectTypes.js";

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
