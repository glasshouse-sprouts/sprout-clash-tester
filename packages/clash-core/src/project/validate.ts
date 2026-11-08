// Validation of a parsed `.clashproj` — strict, so a typo in the file is
// reported here rather than as a confusing engine error.

import { validateSettings } from "../settings.js";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  type Project,
  type ProjectFile,
  type ProjectLastResults,
  type ProjectRule,
  type ProjectRuleSide,
} from "./projectTypes.js";

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
