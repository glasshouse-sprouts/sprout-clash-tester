// The one stderr line the headless MCP server writes on startup (TASKS
// T1). Pure, so it is unit-tested.

export interface StartupInfo {
  version: string;
  /** Resolved `clash` binary (CLASH_BINARY or the repo build). */
  engine: string;
  engineExists: boolean;
  /** Working project file (CLASHTESTER_STATE or ~/.clashtester/state.clashproj). */
  statePath: string;
}

export function startupLine(i: StartupInfo): string {
  const engine = i.engineExists
    ? `engine ${i.engine}`
    : `engine ${i.engine} (MISSING — runs will fail; set CLASH_BINARY or build engine/)`;
  return `clash-tester MCP ${i.version} ready — ${engine}; state ${i.statePath}`;
}
