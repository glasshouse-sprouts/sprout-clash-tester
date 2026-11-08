// Project IPC: open / load / save dialogs, auto-add presets and the
// alignment pre-check.

import { dialog, ipcMain } from "electron";
import {
  autoAddPresets as autoAddPresetsCore,
  checkAlignment as runCheckAlignment,
  loadProject,
  saveProject,
  type AlignmentResult,
  type AutoAddPresetsResult,
  type Project,
} from "@clash-tester/core";
import type { CheckAlignmentArgs, IpcResult, LoadedProject } from "../shared/api.js";
import { fail, ok } from "./ipcResult.js";
import { mainWindow } from "./window.js";

export function registerProjectIpc(): void {
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
}
