// Limits on the file paths an agent can pass to the headless MCP server.
//
// An agent may be steered by content it reads (prompt injection), so the
// tools only touch files they are meant for: project files for
// `project_path`, and Clash Tester run results for `get_results`. See
// SECURITY.md.

import { existsSync, readFileSync } from "node:fs";

/** Extensions a project file may have (the desktop app opens both). */
const PROJECT_EXTENSIONS = [".clashproj", ".json"];

/**
 * Throws unless `p` names a project file (`.clashproj` or `.json`). Stops
 * `project_path` from creating or reading files of any other kind.
 */
export function checkProjectPath(p: string): string {
  const lower = p.toLowerCase();
  if (!PROJECT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(`project_path must end in .clashproj or .json: ${p}`);
  }
  return p;
}

/** What `readRunResult` found. */
export type RunResultRead = { ok: true; text: string } | { ok: false; error: string };

/**
 * Read a Clash Tester run result (`clashes.json`) for `get_results`. Only a
 * `.json` file that parses as a run result is returned, so the tool can't be
 * used to read arbitrary files.
 */
export function readRunResult(p: string): RunResultRead {
  if (!p.toLowerCase().endsWith(".json")) {
    return { ok: false, error: `Not a .json file: ${p}` };
  }
  if (!existsSync(p)) return { ok: false, error: `File does not exist: ${p}` };
  const text = readFileSync(p, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `Not valid JSON: ${p}` };
  }
  if (!isRunResult(parsed)) {
    return { ok: false, error: `Not a Clash Tester result file (clashes.json): ${p}` };
  }
  return { ok: true, text };
}

function isRunResult(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.totalClashes === "number" && Array.isArray(r.clashes);
}
