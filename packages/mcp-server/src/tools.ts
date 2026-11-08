// Tool definitions for the MCP server.
//
// Each tool is `{ name, description, inputSchema, handler }`. The handler
// receives the parsed arguments and returns the text payload that becomes
// the tool's response.
//
// Most tools operate on a working `.clashproj` (loaded via state.ts) and
// delegate domain work to `@clash-tester/core`. They are intentionally
// small — keep the MCP layer dumb, keep `clash-core` the brain.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  autoAddPresets,
  expandProjectToRules,
  formatNotClashes,
  formatOpeningCuts,
  formatPresetList,
  inferDisciplineFromFilename,
  listPresets,
  loadProject,
  run as runEngine,
  SELF_CHECK_DEFAULT_EXCLUDE,
  type Project,
  type ProjectFile,
  type ProjectRule,
} from "@clash-tester/core";
import { dropPlaceholder, loadOrInitState, saveState } from "./state.js";

// ─── Helper types ─────────────────────────────────────────────────────────────

/** What every handler returns to the MCP transport. */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  /** When true, the response is treated as an error by the client. */
  isError?: boolean;
}

function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}
function err(text: string): ToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}

interface Args {
  [key: string]: unknown;
}

/** Resolve the project path: explicit arg wins, else default state path. */
async function loadWorking(args: Args | undefined) {
  const explicit = typeof args?.project_path === "string" ? args.project_path : undefined;
  return loadOrInitState(explicit);
}

// Discipline inference: delegated to `@clash-tester/core` so the
// desktop app, CLI, and MCP server all use one shared heuristic.
// (The Clashero-style behaviour lives in `clash-core/src/discipline.ts`.)
const inferDiscipline = inferDisciplineFromFilename;

/** JSON schema for one side of a custom rule (`.clashproj` rules[].a/b). */
const RULE_SIDE_SCHEMA = {
  type: "object",
  properties: {
    fileId: { type: "string", description: "Id of a registered model (see list_models)." },
    selector: {
      type: "string",
      description: "IFC type selector: exact (IfcBeam), prefix (IfcDuct*), list (IfcWall|IfcSlab), * = all.",
    },
    mode: { type: "string", enum: ["i", "e"], description: "i = include (default), e = everything except selector." },
    exclude: {
      type: "string",
      description:
        "Optional selector of elements to drop after `selector` (same syntax). " +
        "Non-empty when given, e.g. IfcSpace|IfcOpeningElement.",
    },
  },
  required: ["fileId"],
};

/** `ark (*, not IfcSpace|…)` — one custom-rule side as text. */
function sideText(s: { fileId: string; selector?: string; mode?: string; exclude?: string }): string {
  const sel = s.selector ?? "*";
  const parts = [s.mode === "e" ? `all but ${sel}` : sel];
  if (s.exclude) parts.push(`not ${s.exclude}`);
  return `${s.fileId} (${parts.join(", ")})`;
}

// ─── Tool list (used both for ListTools and dispatch) ─────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args | undefined) => Promise<ToolResponse>;
}

export function buildTools(): ToolDef[] {
  return [
    // ── Model registry ────────────────────────────────────────────────────
    {
      name: "list_models",
      description:
        "Show every IFC currently registered in the working project, and optionally scan a folder for more. " +
        "Call this first when the user mentions models or IFC files.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: {
            type: "string",
            description: "Override the working .clashproj path.",
          },
          directory: {
            type: "string",
            description:
              "If given, scan this folder for .ifc files. Unregistered ones are reported with an inferred discipline.",
          },
          auto_register: {
            type: "boolean",
            description: "If true, register every scanned .ifc automatically.",
          },
        },
      },
      handler: async (args) => listModels(args),
    },
    {
      name: "register_model",
      description:
        "Add an IFC file to the working project with a discipline tag (ARCH, STR, MEP, HVAC, ELEC, FIRE, GEO).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Stable id for this model." },
          path: { type: "string", description: "Absolute path to the .ifc file." },
          discipline: {
            type: "string",
            description: "Discipline tag (ARCH, STR, MEP, HVAC, ELEC, FIRE, GEO).",
          },
          project_path: {
            type: "string",
            description: "Override the working .clashproj path.",
          },
        },
        required: ["name", "path", "discipline"],
      },
      handler: async (args) => registerModel(args),
    },
    {
      name: "remove_model",
      description: "Remove a registered IFC by its id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Model id as returned by list_models." },
          project_path: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (args) => removeModel(args),
    },
    // ── Rules ─────────────────────────────────────────────────────────────
    {
      name: "list_clash_rules",
      description: "Show the rules currently saved in the working project.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string" },
        },
      },
      handler: async (args) => listClashRules(args),
    },
    {
      name: "save_clash_rules",
      description:
        "Replace the working project's rules with the array provided. Mix of preset rules and custom rules is allowed. " +
        "A self check is a custom rule with the same fileId on both sides; give both sides " +
        `exclude: "${SELF_CHECK_DEFAULT_EXCLUDE}" to skip spaces and openings (recommended default).`,
      inputSchema: {
        type: "object",
        properties: {
          rules: {
            type: "array",
            description: "Project rules to save (same shape as .clashproj rules[]).",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                preset: {
                  type: ["string", "null"],
                  description: "Preset name for a preset rule; null (or omitted) for a custom rule.",
                },
                enabled: { type: "boolean" },
                a: RULE_SIDE_SCHEMA,
                b: RULE_SIDE_SCHEMA,
              },
              required: ["name"],
            },
          },
          project_path: { type: "string" },
        },
        required: ["rules"],
      },
      handler: async (args) => saveClashRules(args),
    },
    {
      name: "list_presets",
      description: "List the built-in preset rule sets (name, description, sides).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => listPresetsHandler(),
    },
    {
      name: "auto_add_presets",
      description:
        "Look at the working project's registered files and their " +
        "disciplines, then add every shipped preset whose sideA + " +
        "sideB disciplines are both present. Idempotent — skips presets " +
        "already in the project by name. Returns the list of preset " +
        "names added (empty when nothing applies or all applicable " +
        "presets are already present).",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string" },
        },
      },
      handler: async (args) => autoAddPresetsHandler(args),
    },
    // ── Detection ─────────────────────────────────────────────────────────
    {
      name: "run_clash_detection",
      description:
        "Run clash detection against the working project. Writes BCF + JSON + CSV to <output_dir> and returns counts + warnings.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string" },
          output_dir: {
            type: "string",
            description:
              "Where to write BCF/JSON/CSV. Defaults to <state_dir>/outputs/.",
          },
          bcf_topics: {
            type: "string",
            enum: ["clash", "group"],
            description:
              "BCF: one topic per clash (default) or one per clash group (title '<n> - <group title>', " +
              "all the group's elements selected). Overrides the project's settings.bcfTopics.",
          },
        },
      },
      handler: async (args) => runClashDetection(args),
    },
    {
      name: "get_results",
      description:
        "Return a run's JSON summary (the full RunResult), parsed and " +
        "pretty-printed. Resolution order: explicit `json_path` argument → " +
        "the working project's `lastResults` (set by MCP-driven runs) → " +
        "the auto-pointer file written by the desktop app after each run " +
        "(~/.clashtester/last-desktop-run.json). If none of those exist, " +
        "returns a clear error.",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string" },
          json_path: {
            type: "string",
            description:
              "Absolute path to a clashes.json (or any RunResult-shaped JSON). " +
              "When given, this overrides the lastResults / auto-pointer fallbacks.",
          },
        },
      },
      handler: async (args) => getResults(args),
    },
    // ── Viewer hook ───────────────────────────────────────────────────────
    {
      name: "open_in_viewer",
      description:
        "Report the path to the most recent BCF so the caller can open it in Model Viewer (or any BIM viewer).",
      inputSchema: {
        type: "object",
        properties: {
          project_path: { type: "string" },
        },
      },
      handler: async (args) => openInViewer(args),
    },
  ];
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function listModels(args: Args | undefined): Promise<ToolResponse> {
  const { project, path: statePath } = await loadWorking(args);
  const realFiles = project.files.filter((f) => f.id !== "placeholder");
  const lines: string[] = [];
  lines.push(`Working project: ${statePath}`);
  lines.push(`Registered models (${realFiles.length}):`);
  for (const f of realFiles) {
    lines.push(`  [${f.id}] ${f.discipline ?? "UNKNOWN"} — ${f.path}`);
  }
  // Optional folder scan.
  const dir = typeof args?.directory === "string" ? args.directory : undefined;
  if (dir) {
    const auto = args?.auto_register === true;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return err(`Directory not found: ${dir}`);
    }
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".ifc"))
      .map((e) => path.join(dir, e.name));
    const registeredPaths = new Set(realFiles.map((f) => f.path));
    const unregistered = found
      .filter((p) => !registeredPaths.has(p))
      .map((p) => ({
        name: path.basename(p, ".ifc"),
        discipline: inferDiscipline(p),
        path: p,
      }));
    if (auto && unregistered.length > 0) {
      dropPlaceholder(project);
      for (const u of unregistered) {
        project.files.push({ id: makeId(project, u.name), path: u.path, discipline: u.discipline });
      }
      await saveState(statePath, project);
      lines.push("");
      lines.push(`Auto-registered ${unregistered.length} new model(s).`);
    } else if (unregistered.length > 0) {
      lines.push("");
      lines.push(`Unregistered IFCs in ${dir}:`);
      for (const u of unregistered) {
        lines.push(`  ${u.path} (inferred ${u.discipline})`);
      }
      lines.push("Re-call with auto_register: true to add them all.");
    } else if (found.length > 0) {
      lines.push("");
      lines.push(`No new IFCs in ${dir} (all already registered).`);
    }
  }
  return ok(lines.join("\n"));
}

async function registerModel(args: Args | undefined): Promise<ToolResponse> {
  if (typeof args?.name !== "string" || typeof args?.path !== "string" || typeof args?.discipline !== "string") {
    return err("register_model requires 'name', 'path', and 'discipline' strings.");
  }
  const { project, path: statePath } = await loadWorking(args);
  dropPlaceholder(project);
  const id = makeId(project, args.name);
  const entry: ProjectFile = {
    id,
    path: args.path,
    discipline: args.discipline.toUpperCase(),
  };
  project.files.push(entry);
  await saveState(statePath, project);
  return ok(`Registered [${id}] ${entry.discipline} — ${entry.path}`);
}

async function removeModel(args: Args | undefined): Promise<ToolResponse> {
  if (typeof args?.id !== "string") return err("remove_model requires 'id'.");
  const { project, path: statePath } = await loadWorking(args);
  const before = project.files.length;
  project.files = project.files.filter((f) => f.id !== args.id);
  if (project.files.length === before) {
    return err(`No model with id "${args.id}".`);
  }
  await saveState(statePath, project);
  return ok(`Removed model ${args.id}. ${project.files.length} model(s) remaining.`);
}

async function listClashRules(args: Args | undefined): Promise<ToolResponse> {
  const { project } = await loadWorking(args);
  if (project.rules.length === 0) {
    return ok("No rules saved yet. Call save_clash_rules to add some.");
  }
  const lines = ["Current rules:"];
  for (const r of project.rules) {
    const status = r.enabled === false ? "(disabled)" : "(enabled)";
    if ("preset" in r && r.preset) {
      lines.push(`  - ${r.name} ${status} — preset: ${r.preset}`);
    } else if ("a" in r && r.a && "b" in r && r.b) {
      lines.push(
        `  - ${r.name} ${status} — custom: ${sideText(r.a)} vs ${sideText(r.b)}`,
      );
    } else {
      lines.push(`  - ${r.name} ${status}`);
    }
  }
  return ok(lines.join("\n"));
}

async function saveClashRules(args: Args | undefined): Promise<ToolResponse> {
  if (!Array.isArray(args?.rules)) return err("save_clash_rules requires a 'rules' array.");
  const { project, path: statePath } = await loadWorking(args);
  project.rules = args.rules as ProjectRule[];
  // Re-validate by round-tripping through saveProject (which calls validateProject).
  try {
    await saveState(statePath, project);
  } catch (e) {
    return err(`Saved rules failed validation: ${(e as Error).message}`);
  }
  return ok(`Saved ${project.rules.length} rule(s) to ${statePath}.`);
}

async function autoAddPresetsHandler(args: Args | undefined): Promise<ToolResponse> {
  const { project, path: statePath } = await loadWorking(args);
  const { project: next, added, disciplinesSeen } = autoAddPresets(project);
  if (added.length === 0) {
    if (disciplinesSeen.length < 2) {
      return ok(
        `Nothing added — only ${disciplinesSeen.length} distinct discipline(s) tagged so far ` +
          `(${disciplinesSeen.join(", ") || "none"}). Register more files with distinct ` +
          `discipline tags via register_model first.`,
      );
    }
    return ok(
      `Nothing added — all applicable presets are already in your rules. ` +
        `Disciplines seen: ${disciplinesSeen.join(", ")}.`,
    );
  }
  // Persist the updated rules to the state project.
  project.rules = next.rules;
  await saveState(statePath, project);
  return ok(
    `Added ${added.length} preset(s): ${added.join(", ")}.\n` +
      `Disciplines on file: ${disciplinesSeen.join(", ")}.`,
  );
}

async function listPresetsHandler(): Promise<ToolResponse> {
  // Same text as the desktop MCP's ui_list_presets.
  return ok(formatPresetList(listPresets()));
}

async function runClashDetection(args: Args | undefined): Promise<ToolResponse> {
  const { project, path: statePath } = await loadWorking(args);

  // Outputs land next to the state file by default.
  const outputDir =
    typeof args?.output_dir === "string"
      ? args.output_dir
      : path.join(path.dirname(statePath), "outputs");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outputDir, { recursive: true });
  const bcfPath = path.join(outputDir, "report.bcf");
  const jsonPath = path.join(outputDir, "clashes.json");
  const csvPath = path.join(outputDir, "clashes.csv");

  const warnings: string[] = [];
  const rules = expandProjectToRules(project, {
    onWarning: (m) => warnings.push(m),
  });
  if (rules.length === 0) {
    return err(
      `No rules to evaluate. ${warnings.length > 0 ? "Warnings:\n  - " + warnings.join("\n  - ") : "Save rules with save_clash_rules first."}`,
    );
  }

  const bcfTopicsArg = args?.bcf_topics;
  if (bcfTopicsArg !== undefined && bcfTopicsArg !== "clash" && bcfTopicsArg !== "group") {
    return err(`bcf_topics must be "clash" or "group".`);
  }
  const bcfTopics = bcfTopicsArg ?? project.settings.bcfTopics ?? "clash";

  const result = await runEngine({
    rules,
    outputBcf: bcfPath,
    bcfTopics,
    skipRelatedElements: project.settings.skipRelatedElements !== false,
    narrowPhase: project.settings.narrowPhase,
    reportTouch: project.settings.reportTouch === true,
    toleranceMeters: project.settings.toleranceMeters,
    minPenetrationMeters: project.settings.minPenetrationMeters,
    grouping: project.settings.grouping,
  });
  if (!result.ok) {
    return err(
      `Engine exited with code ${result.exitCode}.\nstderr:\n${result.stderr}`,
    );
  }

  // Write JSON + CSV via clash-core (re-import to keep this file lean).
  const { writeResultJson, writeResultCsv, summariseGroups } = await import(
    "@clash-tester/core"
  );
  await writeResultJson(result, jsonPath);
  await writeResultCsv(result, csvPath);

  // Snapshot the last-run pointer into the project.
  project.lastResults = {
    ranAt: new Date().toISOString(),
    totalClashes: result.totalClashes,
    outputs: { bcf: bcfPath, json: jsonPath, csv: csvPath },
  };
  await saveState(statePath, project);

  const perRuleText =
    result.perRule.length > 0
      ? result.perRule
          .map(
            (r) =>
              `  - ${r.name}: ${r.clashes}` +
              (r.skippedByRelations ? ` (${r.skippedByRelations} related pair(s) skipped)` : "") +
              formatNotClashes(r),
          )
          .join("\n")
      : "  (no per-rule data)";
  const warningsText =
    result.warnings.length > 0
      ? "\nEngine warnings:\n" +
        result.warnings.map((w) => `  ! [${w.kind}] ${w.message}`).join("\n")
      : "";
  const expansionText =
    warnings.length > 0
      ? "\nRule-expansion notes:\n" + warnings.map((m) => `  ! ${m}`).join("\n")
      : "";
  // Groups = future task-tracker topics (SPEC §13a). Show the biggest so
  // an agent can talk about "the duct that hits 12 beams" straight away;
  // the full list (with member clash indices) is in clashes.json.
  const groups = result.groups ?? [];
  const TOP = 10;
  const groupsText =
    `\nGrouped into: ${summariseGroups(groups)}` +
    (groups.length > 0
      ? "\nLargest groups:\n" +
        groups
          .slice(0, TOP)
          .map((g) => `  - [${g.key}] ${g.title} — ${g.clashIndices.length} clash(es)`)
          .join("\n") +
        (groups.length > TOP ? `\n  … ${groups.length - TOP} more in clashes.json` : "")
      : "");
  const cutsText = result.openingCuts ? `\n${formatOpeningCuts(result.openingCuts)}` : "";
  return ok(
    `Total clashes: ${result.totalClashes}${cutsText}${groupsText}\nBy rule:\n${perRuleText}${warningsText}${expansionText}\n\nOutputs:\n  BCF  : ${bcfPath} (one topic per ${bcfTopics})\n  JSON : ${jsonPath}\n  CSV  : ${csvPath}`,
  );
}

async function getResults(args: Args | undefined): Promise<ToolResponse> {
  // 1. Explicit `json_path` always wins.
  if (typeof args?.json_path === "string" && args.json_path.length > 0) {
    if (!existsSync(args.json_path)) {
      return err(`json_path does not exist: ${args.json_path}`);
    }
    const raw = readFileSync(args.json_path, "utf-8");
    return ok(`Reading from explicit path: ${args.json_path}\n${raw}`);
  }

  // 2. Working project's `lastResults` (set by MCP-driven runs).
  const { project } = await loadWorking(args);
  const last = project.lastResults;
  if (last) {
    const jsonPath = last.outputs.json;
    if (jsonPath && existsSync(jsonPath)) {
      const raw = readFileSync(jsonPath, "utf-8");
      return ok(
        `Ran at ${last.ranAt}. Total clashes ${last.totalClashes}.\n${raw}`,
      );
    }
  }

  // 3. Cross-app fallback: desktop / CLI runs write an auto-pointer to
  //    ~/.clashtester/last-desktop-run.json after each successful run.
  //    This makes "I just ran in the desktop, look at results" work
  //    without the user having to know paths.
  const pointerPath = path.join(homedir(), ".clashtester", "last-desktop-run.json");
  if (existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as {
        ran_at: string;
        outputs: { json?: string };
      };
      const jsonPath = pointer.outputs?.json;
      if (jsonPath && existsSync(jsonPath)) {
        const raw = readFileSync(jsonPath, "utf-8");
        return ok(
          `Reading from last desktop/CLI run (${pointer.ran_at}):\n${raw}`,
        );
      }
    } catch {
      // Fall through to the "no results" message below.
    }
  }

  return ok(
    "No previous run on record.\n" +
      "Options:\n" +
      "  - Pass an explicit json_path argument, OR\n" +
      "  - Call run_clash_detection to run via MCP, OR\n" +
      "  - Run via the desktop app — its auto-pointer will be picked up next time.",
  );
}

async function openInViewer(args: Args | undefined): Promise<ToolResponse> {
  const { project } = await loadWorking(args);
  const bcf = project.lastResults?.outputs.bcf;
  if (!bcf || !existsSync(bcf)) {
    return err(
      "No BCF on record. Call run_clash_detection first to produce one.",
    );
  }
  return ok(
    `Latest BCF: ${bcf}\n` +
      `Open this file in Model Viewer (or any BIM viewer like BIMcollab / Solibri).`,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate an id that doesn't collide with any existing file in the project. */
function makeId(project: Project, baseName: string): string {
  const base = baseName
    .toLowerCase()
    .replace(/\.ifc$/, "")
    .replace(/[^a-z0-9-_]/g, "-");
  let candidate = base.length > 0 ? base : "model";
  let suffix = 2;
  const seen = new Set(project.files.map((f) => f.id));
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

// `loadProject` re-export so tests that need it don't bounce through state.ts.
export { loadProject };
