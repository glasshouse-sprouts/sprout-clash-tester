// Detection tools: run_clash_detection, get_results, and the viewer hook
// open_in_viewer.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  expandProjectToRules,
  formatNotClashes,
  formatOpeningCuts,
  run as runEngine,
} from "@clash-tester/core";
import { saveState } from "../state.js";
import { err, loadWorking, ok, type Args, type ToolDef, type ToolResponse } from "./common.js";

export function detectionTools(): ToolDef[] {
  return [
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

async function runClashDetection(args: Args | undefined): Promise<ToolResponse> {
  const { project, path: statePath } = await loadWorking(args);

  // Outputs land next to the state file by default.
  const outputDir =
    typeof args?.output_dir === "string"
      ? args.output_dir
      : path.join(path.dirname(statePath), "outputs");
  const { mkdir } = await import("node:fs/promises");
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
  // Groups = future task-tracker topics (docs/HOW-IT-WORKS.md#grouping). Show the biggest so
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
