// Preset clash-rule templates.
//
// Each preset lives in `presets/<name>.json` at the workspace root. A
// preset specifies selectors + disciplines for the two sides of a clash
// rule. At expansion time, the project's `files[]` array (each entry
// tagged with a discipline) provides the actual IFCs the preset applies to.
//
// Presets are loaded once and cached. If you re-edit the presets folder
// during a long-running process, call `clearPresetCache()`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A single preset definition (matches the JSON file on disk). */
export interface PresetDefinition {
  name: string;
  description: string;
  sideA: PresetSide;
  sideB: PresetSide;
}

export interface PresetSide {
  /** IFC type selector — same syntax as ClashRule.SelectionGroup.selector. */
  selector: string;
  /**
   * Discipline tag the preset expects to find in the project's files.
   * If no file in the project has this discipline, the rule is skipped
   * during expansion (with a warning).
   */
  discipline: string;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cached: Map<string, PresetDefinition> | null = null;
let cachedFromDir: string | null = null;

export function clearPresetCache(): void {
  cached = null;
  cachedFromDir = null;
}

// ─── Locating the presets/ folder ─────────────────────────────────────────────

/**
 * Walk up from this file to find the workspace `presets/` directory.
 * Returns the resolved path. Throws if not found within 8 levels (signals
 * we're not inside the expected workspace layout).
 */
function defaultPresetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "presets");
    if (existsSync(path.join(candidate, "HVACxSTR.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate presets/ directory starting from ${here}. ` +
      `Set the dir explicitly via loadPresets({ dir })`,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LoadPresetsOptions {
  /** Override the preset directory. Defaults to `<workspace-root>/presets`. */
  dir?: string;
  /** Skip the cache and re-read from disk. Default `false`. */
  force?: boolean;
}

/**
 * Load every preset JSON file in the presets directory. Returns a map
 * keyed by preset name (also the `name` field inside the JSON).
 *
 * Throws if a file fails to parse or is missing required fields — we'd
 * rather error loudly than ship broken presets.
 */
export function loadPresets(opts: LoadPresetsOptions = {}): Map<string, PresetDefinition> {
  const dir = opts.dir ?? defaultPresetsDir();
  if (cached && cachedFromDir === dir && !opts.force) {
    return cached;
  }
  const entries = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json"));
  const map = new Map<string, PresetDefinition>();
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const raw = readFileSync(full, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Preset ${entry} is not valid JSON: ${(e as Error).message}`);
    }
    const def = validatePreset(parsed, entry);
    if (map.has(def.name)) {
      throw new Error(
        `Preset name "${def.name}" appears in multiple files (latest: ${entry})`,
      );
    }
    map.set(def.name, def);
  }
  cached = map;
  cachedFromDir = dir;
  return map;
}

/** Convenience — fetch a single preset by name. Returns null if missing. */
export function getPreset(name: string, opts?: LoadPresetsOptions): PresetDefinition | null {
  return loadPresets(opts).get(name) ?? null;
}

/** Convenience — list every loaded preset (in directory order). */
export function listPresets(opts?: LoadPresetsOptions): PresetDefinition[] {
  return [...loadPresets(opts).values()];
}

/**
 * Presets as plain text for agents — the `list_presets` (headless MCP)
 * and `ui_list_presets` (desktop MCP) answer. Pure.
 */
export function formatPresetList(presets: readonly PresetDefinition[]): string {
  const lines = [`Built-in presets (${presets.length}):`];
  for (const p of presets) {
    lines.push(`  - ${p.name}: ${p.description}`);
    lines.push(`      side A: ${p.sideA.selector} (discipline ${p.sideA.discipline})`);
    lines.push(`      side B: ${p.sideB.selector} (discipline ${p.sideB.discipline})`);
  }
  return lines.join("\n");
}

/**
 * Return every preset whose `sideA.discipline` AND `sideB.discipline`
 * are both present in the supplied set. Pure — no IO.
 *
 * Used by the desktop's "Auto-add presets" button and the MCP's
 * `auto_add_presets` tool: each looks at a project's `files[]`,
 * collects the disciplines, and asks this helper which presets apply.
 */
export function presetsApplicableTo(
  disciplines: ReadonlySet<string>,
  presetMap?: Map<string, PresetDefinition>,
): PresetDefinition[] {
  const all = presetMap ?? loadPresets();
  const out: PresetDefinition[] = [];
  for (const p of all.values()) {
    if (
      disciplines.has(p.sideA.discipline) &&
      disciplines.has(p.sideB.discipline)
    ) {
      out.push(p);
    }
  }
  return out;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validatePreset(raw: unknown, file: string): PresetDefinition {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Preset ${file}: root must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new Error(`Preset ${file}: 'name' must be a non-empty string`);
  }
  if (typeof r.description !== "string") {
    throw new Error(`Preset ${file}: 'description' must be a string`);
  }
  const sideA = validateSide(r.sideA, `${file}.sideA`);
  const sideB = validateSide(r.sideB, `${file}.sideB`);
  return { name: r.name, description: r.description, sideA, sideB };
}

function validateSide(raw: unknown, prefix: string): PresetSide {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Preset ${prefix}: must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.selector !== "string" || s.selector.length === 0) {
    throw new Error(`Preset ${prefix}.selector: must be a non-empty string`);
  }
  if (typeof s.discipline !== "string" || s.discipline.length === 0) {
    throw new Error(`Preset ${prefix}.discipline: must be a non-empty string`);
  }
  return { selector: s.selector, discipline: s.discipline };
}
