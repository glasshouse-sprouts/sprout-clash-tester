// Which side answers a desktop-MCP tool (SPEC §13d). Pure apart from the
// injected dependencies, so it is tested without Electron.
//
//   ui_list_presets → main (clash-core preset library, same text as the
//                     headless `list_presets`);
//   everything else → the renderer, which owns AppState.

import { UI_TOOLS } from "./server";

export interface RouteDeps {
  /** Forward to the renderer (IPC). */
  callRenderer: (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  /** Text of the preset list. */
  presetText: () => string;
  /** False when the window is gone (closed, not yet created). */
  hasWindow: () => boolean;
}

export async function routeUiTool(
  name: string,
  args: Record<string, unknown>,
  deps: RouteDeps,
): Promise<unknown> {
  if (name === "ui_list_presets") return deps.presetText();
  if (!deps.hasWindow()) {
    throw new Error("The Clash Tester window is closed — open it from the Dock, then retry.");
  }
  const timeoutMs = UI_TOOLS.find((t) => t.name === name)?.timeoutMs;
  return deps.callRenderer(name, args, timeoutMs);
}
