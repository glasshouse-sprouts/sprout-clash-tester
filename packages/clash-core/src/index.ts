// @clash-tester/core — public exports.
//
// Stable surface for the CLI, the desktop app, and the MCP server.
// Anything not exported here is internal.

export const VERSION = "0.1.0" as const;

export { run, checkAlignment, getEnginePath } from "./runner.js";
export { compareNarrowPhases, diffByRule } from "./compare.js";
export type { NarrowPhaseComparison, RuleComparison } from "./compare.js";
export type {
  AlignmentCluster,
  AlignmentFileInput,
  AlignmentFileResult,
  AlignmentResult,
  ClashEntry,
  ClashRule,
  SelectionGroup,
  EngineWarning,
  OpeningCuts,
  RuleCount,
  RunOptions,
  RunResult,
} from "./types.js";

// Project file support (.clashproj) — see project.ts.
export {
  loadProject,
  saveProject,
  validateProject,
  expandProjectToRules,
  suggestPresetsForProject,
  autoAddPresets,
  ProjectValidationError,
  CURRENT_PROJECT_SCHEMA_VERSION,
} from "./project.js";
export {
  SELF_CHECK_DEFAULT_EXCLUDE,
  formatIfcClass,
  formatNotClashes,
  formatOpeningCuts,
} from "./types.js";
export { validateSettings } from "./settings.js";
export type {
  AutoAddPresetsResult,
  ExpandOptions,
  Project,
  ProjectFile,
  ProjectRule,
  ProjectSettings,
  ProjectLastResults,
} from "./project.js";

// Preset rule library (presets/).
export {
  loadPresets,
  getPreset,
  listPresets,
  formatPresetList,
  presetsApplicableTo,
  clearPresetCache,
} from "./presets.js";
export type { PresetDefinition, PresetSide, LoadPresetsOptions } from "./presets.js";

// Output writers (JSON, CSV).
export { writeResultJson, writeResultCsv, csvForResult } from "./writers.js";

// Clash grouping (docs/HOW-IT-WORKS.md#grouping). Pure / browser-safe.
export {
  groupClashes,
  clashKey,
  summariseGroups,
  isLikelyDuplicate,
  duplicateVerdict,
  normaliseIfcType,
  DEFAULT_DUPLICATE_MAX_VOLUME_DIFFERENCE,
  DEFAULT_DUPLICATE_MAX_CENTROID_DISTANCE_METRES,
  DEFAULT_MIN_ELEMENT_CLASHES,
  DEFAULT_PROXIMITY_RADIUS_METRES,
} from "./grouping.js";
export type {
  ClashGroup,
  ClashGroupKind,
  DuplicateInput,
  DuplicateOptions,
  DuplicateVerdict,
  GroupElement,
  GroupingOptions,
  ProximityOptions,
} from "./grouping.js";

// BCF topics per group (docs/HOW-IT-WORKS.md#bcf-topics). Pure.
export { groupToTopic, groupsToTopics, cameraDistance } from "./bcfTopics.js";
export type { BcfTopic, BcfTopicsMode } from "./bcfTopics.js";

// Discipline inference (filename heuristic). Pure / browser-safe.
export { inferDisciplineFromFilename } from "./discipline.js";
export type { Discipline } from "./discipline.js";
