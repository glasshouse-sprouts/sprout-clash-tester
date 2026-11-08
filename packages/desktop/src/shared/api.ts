// Shared type definitions for the IPC bridge between main and renderer.
//
// Anything passing across IPC MUST be JSON-serialisable. No class
// instances, no functions, no Maps. Plain objects only.
//
// Both processes import this file (via tsconfig.web/node `include`).
// Keep it small and pure.

import type { AlignmentResult, AutoAddPresetsResult, Project, RunResult } from "@clash-tester/core";
import type { McpIpcRequest, McpIpcResponse } from "./mcp/protocol.js";

/** Result envelope for IPC calls — always { ok, value } or { ok: false, error }. */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; issues?: string[] };

/** Result of openProject — the project plus the absolute path it lives at. */
export interface LoadedProject {
  path: string;
  project: Project;
}

/**
 * Arguments passed to runDetection.
 *
 * `project` is the in-memory state — we don't read from disk. This
 * lets the user run detection without saving first. `projectPath` is
 * a hint for where to write output files (defaults to a temp dir
 * when null, so the renderer doesn't have to invent a path).
 */
export interface RunDetectionArgs {
  project: Project;
  projectPath: string | null;
  outputDir?: string;
}

/** Return shape for runDetection. The runner result plus output paths. */
export interface RunDetectionResult extends RunResult {
  durationMs: number;
  outputs: RunResult["outputs"] & { json: string; csv: string };
}

/** Arguments passed to checkAlignment. */
export interface CheckAlignmentArgs {
  /** Per-file inputs — paths + optional translation. */
  files: { file: string; translation?: [number, number, number] }[];
}

/** Shape of `window.api` exposed by the preload script. */
export interface DesktopApi {
  /** Ask the OS for a file-open dialog (single .clashproj). */
  openProjectDialog: () => Promise<IpcResult<LoadedProject | null>>;
  /** Load a project by path. */
  loadProject: (path: string) => Promise<IpcResult<LoadedProject>>;
  /** Save a project to its path. */
  saveProject: (path: string, project: Project) => Promise<IpcResult<true>>;
  /** Save-as dialog: returns the chosen path (or null if cancelled). */
  saveProjectAs: (project: Project) => Promise<IpcResult<string | null>>;
  /** Run clash detection. */
  runDetection: (args: RunDetectionArgs) => Promise<IpcResult<RunDetectionResult>>;
  /**
   * Run the engine's fast IFCSITE-origin alignment pre-check. Returns
   * clusters + warnings without paying the full clash-detection cost.
   * Typically auto-called by the renderer when files change.
   */
  checkAlignment: (args: CheckAlignmentArgs) => Promise<IpcResult<AlignmentResult>>;
  /**
   * Run the pure-data autoAddPresets helper against a project.
   * Returns the project with new preset rules appended (idempotent —
   * skips presets the project already has by name). The renderer
   * applies the returned project via patch.
   */
  autoAddPresets: (project: Project) => Promise<IpcResult<AutoAddPresetsResult>>;
  /** Open a folder/file in the OS file manager. */
  revealInFolder: (path: string) => Promise<IpcResult<true>>;
  /**
   * Show a save-as dialog and copy the source file to the user's chosen
   * destination. Returns the destination path, or null when cancelled.
   * Used by the Results view's Export buttons.
   */
  exportFile: (
    sourcePath: string,
    defaultName: string,
  ) => Promise<IpcResult<string | null>>;
  /**
   * Called by the renderer after handling a "save before close" event,
   * regardless of whether the save succeeded. Tells the main process
   * it's safe to destroy the window now.
   */
  confirmCloseAfterSave: () => Promise<IpcResult<true>>;
  /** Inspect a file path passed in from the OS (e.g. dragged IFCs). */
  pingPaths: (paths: string[]) => Promise<
    IpcResult<{ path: string; isFile: boolean; isIfc: boolean }[]>
  >;
  /**
   * Push the current `dirty` state of the renderer to the main
   * process. Main uses this to drive the close-with-prompt dialog.
   * Should be called every time `state.dirty` changes.
   */
  setDirty: (dirty: boolean) => Promise<IpcResult<true>>;
  /**
   * Get the absolute filesystem path of a dropped `File` object.
   *
   * Electron 32 removed the long-standing `File.path` property for
   * alignment with the web standard. The replacement is the
   * `webUtils.getPathForFile()` API, which can only be reached from the
   * preload context — hence this bridge method. Returns an empty string
   * if the File doesn't have an associated on-disk path (e.g. it came
   * from the clipboard or a `<input type="file">` in a packaged app
   * without that permission).
   *
   * Synchronous in spirit — kept Promise-shaped for IPC consistency.
   */
  getPathForFile: (file: File) => string;
}

/** Subscribe / unsubscribe for streamed run progress lines. */
export interface DesktopEvents {
  onRunProgress: (handler: (line: string) => void) => void;
  offRunProgress: (handler: (line: string) => void) => void;
  /**
   * The main process fires this when the user clicks the window's
   * close button and we have unsaved changes. The renderer should
   * Save (or skip), then call `window.api.confirmCloseAfterSave()`
   * to let main destroy the window.
   */
  onSaveBeforeClose: (handler: () => void) => void;
  offSaveBeforeClose: (handler: () => void) => void;
  /** Desktop MCP: a tool call for the renderer to run
   * (docs/MCP.md#desktop-live-ui--clash-tester-ui). */
  onMcpRequest: (handler: (req: McpIpcRequest) => void) => void;
  offMcpRequest: (handler: (req: McpIpcRequest) => void) => void;
  /** Answer an `onMcpRequest` call (same `id`). */
  respondMcp: (response: McpIpcResponse) => void;
}

declare global {
  interface Window {
    api: DesktopApi;
    events: DesktopEvents;
  }
}
