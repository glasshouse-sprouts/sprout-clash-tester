// Rule tools: list_clash_rules, save_clash_rules, list_presets,
// auto_add_presets.

import {
  autoAddPresets,
  formatPresetList,
  listPresets,
  SELF_CHECK_DEFAULT_EXCLUDE,
  type ProjectRule,
} from "@clash-tester/core";
import { saveState } from "../state.js";
import { err, loadWorking, ok, type Args, type ToolDef, type ToolResponse } from "./common.js";

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

export function ruleTools(): ToolDef[] {
  return [
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
  ];
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
