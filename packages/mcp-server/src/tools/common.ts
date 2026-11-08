// Shared pieces of the MCP tools: response helpers, the tool shape and
// loading the working project.

import { loadOrInitState } from "../state.js";
import { checkProjectPath } from "./guards.js";

// ─── Helper types ─────────────────────────────────────────────────────────────

/** What every handler returns to the MCP transport. */
export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  /** When true, the response is treated as an error by the client. */
  isError?: boolean;
}

export function ok(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}
export function err(text: string): ToolResponse {
  return { content: [{ type: "text", text }], isError: true };
}

export interface Args {
  [key: string]: unknown;
}

/**
 * Resolve the project path: explicit arg wins, else default state path. An
 * explicit `project_path` must name a project file (see guards.ts).
 */
export async function loadWorking(args: Args | undefined) {
  const explicit = typeof args?.project_path === "string" ? args.project_path : undefined;
  return loadOrInitState(explicit === undefined ? undefined : checkProjectPath(explicit));
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args | undefined) => Promise<ToolResponse>;
}
