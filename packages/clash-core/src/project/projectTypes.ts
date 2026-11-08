// Types of a `.clashproj` project file (docs/PROJECT-FILE.md).

import type { ProjectSettings } from "../settings.js";

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
   * Edge cases only — see docs/HOW-IT-WORKS.md#coordinates-and-units.
   */
  translation?: [number, number, number];
}

export type ProjectRule = ProjectRulePreset | ProjectRuleCustom;

/** A rule that references a preset by name. */
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
