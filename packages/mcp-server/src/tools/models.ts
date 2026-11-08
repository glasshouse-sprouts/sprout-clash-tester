// Model registry tools: list_models, register_model, remove_model.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inferDisciplineFromFilename, type Project, type ProjectFile } from "@clash-tester/core";
import { dropPlaceholder, saveState } from "../state.js";
import { err, loadWorking, ok, type Args, type ToolDef, type ToolResponse } from "./common.js";

// Discipline inference: delegated to `@clash-tester/core` so the
// desktop app, CLI, and MCP server all use one shared heuristic.
// (The Clashero-style behaviour lives in `clash-core/src/discipline.ts`.)
const inferDiscipline = inferDisciplineFromFilename;

export function modelTools(): ToolDef[] {
  return [
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
  ];
}

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
