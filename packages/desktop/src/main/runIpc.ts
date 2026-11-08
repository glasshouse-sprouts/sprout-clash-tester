// The "project:run" IPC: run clash detection on the in-memory project,
// write BCF/JSON/CSV and the cross-app last-run pointer.

import { ipcMain } from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  expandProjectToRules,
  run as runEngine,
  writeResultCsv,
  writeResultJson,
} from "@clash-tester/core";
import type { IpcResult, RunDetectionArgs, RunDetectionResult } from "../shared/api.js";
import { fail, ok } from "./ipcResult.js";
import { mainWindow } from "./window.js";

export function registerRunIpc(): void {
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
}
