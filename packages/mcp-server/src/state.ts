// MCP-server state: the working .clashproj the server reads and writes
// between tool calls.
//
// By default this lives at `~/.clashtester/state.clashproj`. The
// `CLASHTESTER_STATE` env var overrides the path entirely. Individual
// tool calls can also accept a `project_path` argument to operate
// against a different file.
//
// We keep the file format identical to the user-facing `.clashproj` so
// MCP-managed projects and CLI-managed projects are interchangeable.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  loadProject,
  saveProject,
  type Project,
} from "@clash-tester/core";

/** Where the working state lives. CLASHTESTER_STATE wins, else $HOME/.clashtester. */
export function defaultStatePath(): string {
  if (process.env.CLASHTESTER_STATE) return process.env.CLASHTESTER_STATE;
  return path.join(homedir(), ".clashtester", "state.clashproj");
}

/**
 * Load the working project. If the file doesn't exist, create a fresh empty
 * one and save it before returning. So callers can rely on a project being
 * there without each tool checking for existence.
 */
export async function loadOrInitState(filePath: string = defaultStatePath()): Promise<{
  project: Project;
  path: string;
}> {
  if (!existsSync(filePath)) {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const fresh = emptyProject();
    await saveProject(filePath, fresh);
    return { project: fresh, path: filePath };
  }
  return { project: await loadProject(filePath), path: filePath };
}

/** Save the state project back to its path. */
export async function saveState(filePath: string, project: Project): Promise<void> {
  await saveProject(filePath, project);
}

/** A blank-but-valid project — used when no state exists yet. */
export function emptyProject(): Project {
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: "MCP working project",
    createdAt: new Date().toISOString(),
    // validateProject requires at least one file. We add a placeholder
    // entry that the user is expected to overwrite with register_model.
    // The placeholder path is a sentinel — register_model treats this
    // exactly like any other state and replaces it.
    files: [
      {
        id: "placeholder",
        path: "/nonexistent/placeholder.ifc",
        discipline: "UNKNOWN",
      },
    ],
    rules: [],
    settings: { toleranceMeters: 0, minPenetrationMeters: 0.005 },
  };
}

/**
 * Remove the synthetic placeholder file entry once the user has added
 * real ones. Called by tools that mutate `files[]`.
 */
export function dropPlaceholder(project: Project): void {
  project.files = project.files.filter(
    (f) => !(f.id === "placeholder" && f.path === "/nonexistent/placeholder.ifc"),
  );
}
