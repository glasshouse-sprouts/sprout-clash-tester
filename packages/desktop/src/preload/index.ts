// Preload script: the secure bridge between main and renderer.
//
// We expose a small, typed surface on window.api. The renderer can only
// call exactly these methods — nothing else. All of them route to
// ipcMain handlers in main/index.ts.

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopApi, DesktopEvents } from "../shared/api.js";
import { MCP_CHANNELS, type McpIpcRequest } from "../shared/mcp/protocol.js";

const api: DesktopApi = {
  openProjectDialog: () => ipcRenderer.invoke("project:openDialog"),
  loadProject: (p) => ipcRenderer.invoke("project:load", p),
  saveProject: (p, project) => ipcRenderer.invoke("project:save", p, project),
  saveProjectAs: (project) => ipcRenderer.invoke("project:saveAs", project),
  runDetection: (args) => ipcRenderer.invoke("project:run", args),
  checkAlignment: (args) => ipcRenderer.invoke("project:checkAlignment", args),
  autoAddPresets: (project) =>
    ipcRenderer.invoke("project:autoAddPresets", project),
  revealInFolder: (p) => ipcRenderer.invoke("os:reveal", p),
  exportFile: (src, def) => ipcRenderer.invoke("os:exportFile", src, def),
  pingPaths: (paths) => ipcRenderer.invoke("os:pingPaths", paths),
  setDirty: (d) => ipcRenderer.invoke("app:setDirty", d),
  confirmCloseAfterSave: () => ipcRenderer.invoke("app:confirmCloseAfterSave"),
  // `webUtils.getPathForFile` is the Electron 32+ replacement for the
  // old `File.path` property. Must be called from preload (renderer
  // can't import 'electron' with context isolation on). The bridge
  // happily marshals File handles across.
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
};

/**
 * One-way streaming events from the main process to the renderer.
 * Currently just run-progress lines.
 *
 * We wrap the listener so consumers pass a plain `(line: string)`
 * callback — they don't see the `IpcRendererEvent` first argument that
 * Electron's API would normally hand over.
 */
const events: DesktopEvents = {
  onRunProgress: (handler) => {
    const wrapped = (_e: unknown, line: string) => handler(line);
    (handler as { _wrap?: (e: unknown, l: string) => void })._wrap = wrapped;
    ipcRenderer.on("project:runProgress", wrapped);
  },
  offRunProgress: (handler) => {
    const wrapped = (handler as { _wrap?: (e: unknown, l: string) => void })
      ._wrap;
    if (wrapped) {
      ipcRenderer.off("project:runProgress", wrapped);
    }
  },
  onSaveBeforeClose: (handler) => {
    const wrapped = () => handler();
    (handler as { _wrap?: () => void })._wrap = wrapped;
    ipcRenderer.on("app:saveBeforeClose", wrapped);
  },
  offSaveBeforeClose: (handler) => {
    const wrapped = (handler as { _wrap?: () => void })._wrap;
    if (wrapped) ipcRenderer.off("app:saveBeforeClose", wrapped);
  },
  // Desktop MCP (docs/MCP.md#desktop-live-ui--clash-tester-ui): main asks the renderer to run a
  // tool op; the renderer answers with `respondMcp`.
  onMcpRequest: (handler) => {
    const wrapped = (_e: unknown, req: McpIpcRequest) => handler(req);
    (handler as { _wrap?: (e: unknown, r: McpIpcRequest) => void })._wrap = wrapped;
    ipcRenderer.on(MCP_CHANNELS.request, wrapped);
  },
  offMcpRequest: (handler) => {
    const wrapped = (handler as { _wrap?: (e: unknown, r: McpIpcRequest) => void })._wrap;
    if (wrapped) ipcRenderer.off(MCP_CHANNELS.request, wrapped);
  },
  respondMcp: (response) => ipcRenderer.send(MCP_CHANNELS.response, response),
};

contextBridge.exposeInMainWorld("api", api);
contextBridge.exposeInMainWorld("events", events);
