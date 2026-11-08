// Tool definitions for the MCP server.
//
// Each tool is `{ name, description, inputSchema, handler }`. The handler
// receives the parsed arguments and returns the text payload that becomes
// the tool's response.
//
// Most tools operate on a working `.clashproj` (loaded via state.ts) and
// delegate domain work to `@clash-tester/core`. They are intentionally
// small — keep the MCP layer dumb, keep `clash-core` the brain.
//
// One file per tool group in ./tools/; this file puts them together.

import { loadProject } from "@clash-tester/core";
import type { ToolDef } from "./tools/common.js";
import { detectionTools } from "./tools/detection.js";
import { modelTools } from "./tools/models.js";
import { ruleTools } from "./tools/rules.js";

export type { ToolDef, ToolResponse } from "./tools/common.js";

export function buildTools(): ToolDef[] {
  return [...modelTools(), ...ruleTools(), ...detectionTools()];
}

// `loadProject` re-export so tests that need it don't bounce through state.ts.
export { loadProject };
