// Expansion of a project's rules to the engine's clash-set JSON
// (`ClashRule[]`), presets resolved against the files' disciplines.

import type { PresetDefinition } from "../presets.js";
import { loadPresets } from "../presets.js";
import type { ClashRule, SelectionGroup } from "../types.js";
import type {
  Project,
  ProjectFile,
  ProjectRule,
  ProjectRulePreset,
  ProjectRuleSide,
} from "./projectTypes.js";

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
