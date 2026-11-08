// Electron main process for the Clash Tester desktop app.
//
// Responsibilities:
//   - Create the application window.
//   - Bridge between the renderer (sandboxed) and the file system /
//     `@clash-tester/core` runner.
//   - Show native file dialogs.
//
// Everything substantive happens via clash-core; this file is glue.

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoAddPresets as autoAddPresetsCore,
  checkAlignment as runCheckAlignment,
  expandProjectToRules,
  formatPresetList,
  listPresets,
  loadProject,
  ProjectValidationError,
  run as runEngine,
  saveProject,
  writeResultCsv,
  writeResultJson,
  type AlignmentResult,
  type AutoAddPresetsResult,
  type Project,
} from "@clash-tester/core";
import type {
  CheckAlignmentArgs,
  IpcResult,
  LoadedProject,
  RunDetectionArgs,
  RunDetectionResult,
} from "../shared/api.js";
import { UI_MCP_DEFAULT_PORT } from "../shared/mcp/protocol.js";
import { callRenderer, cancelAllPending } from "./mcp/bridge.js";
import { routeUiTool } from "./mcp/route.js";
import { startUiMcpServer, type UiMcpServer } from "./mcp/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

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
  // electron-vite emits the preload as .mjs when package.json is type:module.
  const candidates = ["index.mjs", "index.js", "index.cjs"];
  for (const f of candidates) {
    const p = path.join(__dirname, "../preload", f);
    if (existsSync(p)) return p;
  }
  return path.join(__dirname, "../preload", candidates[0]!);
}

function createWindow(): void {
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
      sandbox: false,
    },
  });

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

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  if (err instanceof ProjectValidationError) {
    return { ok: false, error: err.message, issues: err.issues };
  }
  if (err instanceof Error) return { ok: false, error: err.message };
  return { ok: false, error: String(err) };
}

ipcMain.handle("project:openDialog", async (): Promise<
  IpcResult<LoadedProject | null>
> => {
  if (!mainWindow) return fail(new Error("Window not ready"));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open clash project",
    properties: ["openFile"],
    filters: [{ name: "Clash projects", extensions: ["clashproj", "json"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return ok(null);
  try {
    const projPath = result.filePaths[0]!;
    const project = await loadProject(projPath);
    return ok({ path: projPath, project });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("project:load", async (_e, p: string): Promise<
  IpcResult<LoadedProject>
> => {
  try {
    return ok({ path: p, project: await loadProject(p) });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("project:save", async (
  _e,
  p: string,
  project: Project,
): Promise<IpcResult<true>> => {
  try {
    await saveProject(p, project);
    return ok(true);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("project:saveAs", async (
  _e,
  project: Project,
): Promise<IpcResult<string | null>> => {
  if (!mainWindow) return fail(new Error("Window not ready"));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save clash project",
    defaultPath: `${project.name.replace(/[^a-zA-Z0-9-_]/g, "-")}.clashproj`,
    filters: [{ name: "Clash projects", extensions: ["clashproj"] }],
  });
  if (result.canceled || !result.filePath) return ok(null);
  try {
    await saveProject(result.filePath, project);
    return ok(result.filePath);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("project:run", async (
  _e,
  args: RunDetectionArgs,
): Promise<IpcResult<RunDetectionResult>> => {
  try {
    // The renderer passes the in-memory project. We never read from
    // disk here — so the user can run without saving first.
    const project = args.project;
    // Output directory selection:
    //   1. Explicit override via args.outputDir.
    //   2. Next to the project file if one exists on disk.
    //   3. Fall back to a fresh temp dir — outputs are still reachable
    //      via the Show / Export buttons in the Results view.
    let outDir: string;
    if (args.outputDir) {
      outDir = args.outputDir;
    } else if (args.projectPath) {
      outDir = path.join(path.dirname(args.projectPath), "outputs");
    } else {
      outDir = await mkdtemp(path.join(tmpdir(), "clashtester-run-"));
    }
    await mkdir(outDir, { recursive: true });
    const bcfPath = path.join(outDir, "report.bcf");
    const jsonPath = path.join(outDir, "clashes.json");
    const csvPath = path.join(outDir, "clashes.csv");

    const expansionWarnings: string[] = [];
    const rules = expandProjectToRules(project, {
      onWarning: (m) => expansionWarnings.push(m),
    });
    if (rules.length === 0) {
      return fail(
        new Error(
          `No rules to evaluate.${expansionWarnings.length > 0 ? "\n" + expansionWarnings.join("\n") : ""}`,
        ),
      );
    }
    const t0 = Date.now();
    const result = await runEngine({
      rules,
      outputBcf: bcfPath,
      bcfTopics: project.settings.bcfTopics ?? "clash",
      skipRelatedElements: project.settings.skipRelatedElements !== false,
      narrowPhase: project.settings.narrowPhase,
      reportTouch: project.settings.reportTouch === true,
      toleranceMeters: project.settings.toleranceMeters,
      minPenetrationMeters: project.settings.minPenetrationMeters,
      grouping: project.settings.grouping,
      // Stream each engine stdout line to the renderer for live
      // progress. The renderer parses these via a pure reducer; we
      // just forward the raw text.
      onProgress: (line) => {
        // Guard against the window having closed mid-run.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("project:runProgress", line);
        }
      },
    });
    const durationMs = Date.now() - t0;
    await writeResultJson(result, jsonPath);
    await writeResultCsv(result, csvPath);
    if (!result.ok) {
      return fail(new Error(result.stderr || `Engine exit ${result.exitCode}`));
    }
    // Merge expansion-time warnings into the engine's warnings so the
    // Results view can show them. Otherwise the user has no idea why
    // a preset rule produced zero clashes — it may have been silently
    // skipped because no files had the matching discipline tag.
    const mergedWarnings = [
      ...result.warnings,
      ...expansionWarnings.map((m) => ({
        kind: "rule_expansion",
        message: m,
        files: [] as string[],
      })),
    ];
    // Write the cross-app auto-pointer. The MCP server's `get_results`
    // falls back to this when its own state has no recorded run — so
    // "I just ran in the desktop, ask Claude about the results" works
    // without manual file paths.
    try {
      const pointerDir = path.join(homedir(), ".clashtester");
      await mkdir(pointerDir, { recursive: true });
      const pointer = {
        ran_at: new Date().toISOString(),
        project_path: args.projectPath ?? null,
        outputs: {
          bcf: bcfPath,
          json: jsonPath,
          csv: csvPath,
        },
      };
      await writeFile(
        path.join(pointerDir, "last-desktop-run.json"),
        JSON.stringify(pointer, null, 2),
        "utf-8",
      );
    } catch {
      // Pointer is best-effort — failing to write it shouldn't fail
      // the run. (Most likely cause: HOME unwritable; rare.)
    }

    return ok({
      ...result,
      warnings: mergedWarnings,
      durationMs,
      outputs: { ...result.outputs, json: jsonPath, csv: csvPath, bcf: bcfPath },
    });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle(
  "project:autoAddPresets",
  async (_e, project: Project): Promise<IpcResult<AutoAddPresetsResult>> => {
    try {
      const result = autoAddPresetsCore(project);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

ipcMain.handle("project:checkAlignment", async (
  _e,
  args: CheckAlignmentArgs,
): Promise<IpcResult<AlignmentResult>> => {
  try {
    const result = await runCheckAlignment({
      files: args.files,
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
});

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

ipcMain.handle("os:reveal", async (_e, p: string): Promise<IpcResult<true>> => {
  try {
    shell.showItemInFolder(p);
    return ok(true);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("os:exportFile", async (
  _e,
  source: string,
  defaultName: string,
): Promise<IpcResult<string | null>> => {
  if (!mainWindow) return fail(new Error("Window not ready"));
  if (!existsSync(source)) {
    return fail(new Error(`Source file no longer exists: ${source}`));
  }
  const ext = path.extname(defaultName).replace(/^\./, "");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export…",
    defaultPath: defaultName,
    filters: ext
      ? [
          { name: ext.toUpperCase(), extensions: [ext] },
          { name: "All Files", extensions: ["*"] },
        ]
      : undefined,
  });
  if (result.canceled || !result.filePath) return ok(null);
  try {
    await copyFile(source, result.filePath);
    return ok(result.filePath);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle("os:pingPaths", async (
  _e,
  paths: string[],
): Promise<IpcResult<{ path: string; isFile: boolean; isIfc: boolean }[]>> => {
  try {
    const results = paths.map((p) => {
      const s = existsSync(p) ? statSync(p) : null;
      return {
        path: p,
        isFile: s !== null && s.isFile(),
        isIfc: p.toLowerCase().endsWith(".ifc"),
      };
    });
    return ok(results);
  } catch (err) {
    return fail(err);
  }
});
