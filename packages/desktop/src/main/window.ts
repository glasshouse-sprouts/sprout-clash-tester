// The application window and its close-with-prompt flow.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcResult } from "../shared/api.js";
import { ok } from "./ipcResult.js";
import { cancelAllPending } from "./mcp/bridge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

export let mainWindow: BrowserWindow | null = null;

/**
 * Dirty-state tracking for the close-with-prompt dialog. The renderer
 * pushes its `state.dirty` here whenever it changes. Combined with
 * `closingApproved`, we use it to intercept window-close requests and
 * give the user a chance to save first.
 */
let rendererDirty = false;
/**
 * Flips to `true` once we've shown the prompt and the renderer has
 * confirmed (saved or chose discard). Next close request goes through.
 */
let closingApproved = false;

function resolvePreload(): string {
  // Built as CommonJS (electron.vite.config.ts) so the renderer can run
  // sandboxed; the others are fallbacks for older builds.
  const candidates = ["index.cjs", "index.mjs", "index.js"];
  for (const f of candidates) {
    const p = path.join(__dirname, "../preload", f);
    if (existsSync(p)) return p;
  }
  return path.join(__dirname, "../preload", candidates[0]!);
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#0e1116",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The window only ever shows the app itself (SECURITY.md): no new
  // windows, no navigation away (e.g. a dropped HTML file or a link), and
  // no browser permissions (camera, notifications, …) — the app uses none.
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    cancelAllPending("The Clash Tester window was closed.");
    mainWindow = null;
  });

  // Close-with-prompt. We intercept the first close request when the
  // renderer is dirty, show a native dialog, and either:
  //   - Save → tell the renderer to run its save flow, then close.
  //   - Discard → mark approved, close immediately.
  //   - Cancel → keep the window open.
  mainWindow.on("close", (event) => {
    if (!rendererDirty || closingApproved) return;
    event.preventDefault();
    if (!mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["Save", "Discard", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Unsaved changes",
      message: "You have unsaved changes. Save before closing?",
      detail: "Your project has been edited since the last Save.",
    });
    if (choice === 2) return; // Cancel — leave the window alone.
    if (choice === 1) {
      // Discard — just close.
      closingApproved = true;
      rendererDirty = false;
      mainWindow.close();
      return;
    }
    // Save chosen. Ask the renderer to run its save flow; it will
    // come back via `app:confirmCloseAfterSave` once done (or failed).
    mainWindow.webContents.send("app:saveBeforeClose");
  });
}

/** IPC the renderer uses to report dirty state and finish a close. */
export function registerWindowIpc(): void {
  ipcMain.handle(
    "app:setDirty",
    async (_e, d: boolean): Promise<IpcResult<true>> => {
      rendererDirty = !!d;
      return ok(true);
    },
  );

  ipcMain.handle(
    "app:confirmCloseAfterSave",
    async (): Promise<IpcResult<true>> => {
      // Renderer has finished its save flow (success or otherwise). Let
      // the close proceed unconditionally — we already had the user's
      // intent.
      closingApproved = true;
      rendererDirty = false;
      if (mainWindow) mainWindow.close();
      return ok(true);
    },
  );
}
