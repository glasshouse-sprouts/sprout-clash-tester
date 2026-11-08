// Electron main process for the Clash Tester desktop app.
//
// Responsibilities:
//   - Create the application window.
//   - Bridge between the renderer (sandboxed) and the file system /
//     `@clash-tester/core` runner.
//   - Show native file dialogs.
//
// Everything substantive happens via clash-core; this file is glue.
//
// Window: window.ts. IPC handlers: projectIpc.ts, runIpc.ts, osIpc.ts and
// the window's own in window.ts. This file: app lifecycle + desktop MCP.

import { app, BrowserWindow } from "electron";
import { formatPresetList, listPresets } from "@clash-tester/core";
import { UI_MCP_DEFAULT_PORT } from "../shared/mcp/protocol.js";
import { callRenderer, cancelAllPending } from "./mcp/bridge.js";
import { routeUiTool } from "./mcp/route.js";
import { startUiMcpServer, type UiMcpServer } from "./mcp/server.js";
import { registerOsIpc } from "./osIpc.js";
import { registerProjectIpc } from "./projectIpc.js";
import { registerRunIpc } from "./runIpc.js";
import { createWindow, mainWindow, registerWindowIpc } from "./window.js";

// One app instance at a time: a second launch focuses the first window
// instead of fighting over the desktop MCP port (SPEC §13d).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

let uiMcp: UiMcpServer | null = null;

/** Start the desktop MCP server ("clash-tester-ui"). Never fatal. */
async function startDesktopMcp(): Promise<void> {
  const port = Number(process.env.CLASHTESTER_UI_PORT ?? UI_MCP_DEFAULT_PORT);
  try {
    uiMcp = await startUiMcpServer({
      port,
      version: app.getVersion(),
      callTool: (name, args) =>
        routeUiTool(name, args, {
          hasWindow: () => mainWindow !== null && !mainWindow.isDestroyed(),
          callRenderer: (op, a, timeoutMs) => callRenderer(mainWindow!, op, a, timeoutMs),
          presetText: () => formatPresetList(listPresets()),
        }),
    });
  } catch (err) {
    // Port taken (another app?) — the app still works, only the MCP
    // is unavailable. Logged for `npm run dev` / Console.app.
    console.error(`[ui-mcp] not started on port ${port}: ${(err as Error).message}`);
  }
}

app.whenReady().then(() => {
  createWindow();
  void startDesktopMcp();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  cancelAllPending("Clash Tester is quitting.");
  void uiMcp?.close();
  uiMcp = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ─── IPC handlers ─────────────────────────────────────────────────────────────

registerProjectIpc();
registerRunIpc();
registerWindowIpc();
registerOsIpc();
