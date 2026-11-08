// Shared MCP protocol shapes — main ⇄ renderer IPC (SPEC §13d).
//
// Adapted from Model Viewer (`src/shared/mcp/protocol.ts`),
// Copyright 2025-2026 3DBYGGERI DANMARK ApS, licensed under the Apache
// License, Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0
//
// The MCP server runs in the Electron main process (HTTP on localhost).
// Each tool call that needs the UI is forwarded to the renderer: main
// sends `mcp:request` with a unique id; the renderer runs the op against
// its AppState and replies on `mcp:response`. Main keeps a pending-promise
// map keyed by id so in-flight calls don't interleave.
//
// Op names are the public tool names (`ui_get_state`, …) so the renderer
// dispatches with a flat table.

export interface McpIpcRequest {
  /** UUID — main correlates responses by this. */
  id: string;
  /** Tool name, e.g. `ui_select_clash`. */
  op: string;
  /** Tool arguments as sent by the client. */
  args: Record<string, unknown>;
}

export interface McpIpcResponse {
  id: string;
  ok: boolean;
  /** Present when `ok=true`. Op-defined, JSON-serialisable. */
  data?: unknown;
  /** Present when `ok=false`. Human-readable; becomes a tool error. */
  error?: string;
}

/** IPC channel names, namespaced under `mcp:`. */
export const MCP_CHANNELS = {
  /** main → renderer: please run this op. */
  request: "mcp:request",
  /** renderer → main: result of an op. */
  response: "mcp:response",
} as const;

/** Default port of the desktop MCP server (Model Viewer owns 7711). */
export const UI_MCP_DEFAULT_PORT = 7712;

/** One tool as listed to MCP clients (`ui-tools.json`). */
export interface UiToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Renderer timeout in ms; omitted ⇒ the bridge default (10 s). */
  timeoutMs?: number;
}
