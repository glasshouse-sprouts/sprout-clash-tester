// OS IPC: reveal in folder, export a copy, check dropped paths.

import { dialog, ipcMain, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { IpcResult } from "../shared/api.js";
import { fail, ok } from "./ipcResult.js";
import { mainWindow } from "./window.js";

export function registerOsIpc(): void {
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
}
