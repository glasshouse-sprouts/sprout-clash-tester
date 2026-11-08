// Main-side IPC bridge: MCP tool calls → renderer ops
// (docs/MCP.md#desktop-live-ui--clash-tester-ui).
//
// Adapted from Sprout · Fragments (`src/main/mcp/bridge.ts`),
// Copyright 2025-2026 3DBYGGERI DANMARK ApS, licensed under the Apache
// License, Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0
//
// Every call gets a UUID and goes out on `mcp:request`; the renderer
// answers on `mcp:response`. A pending map routes answers back, and a
// timeout stops a stuck renderer from leaking promises. Most ops take
// milliseconds; `ui_run` passes a long timeout (see ui-tools.json).

import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { MCP_CHANNELS, type McpIpcResponse } from "../../shared/mcp/protocol";

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
const pending = new Map<string, Pending>();
let listenerAttached = false;

function attachOnce(): void {
  if (listenerAttached) return;
  ipcMain.on(MCP_CHANNELS.response, (_event, msg: McpIpcResponse) => {
    const entry = pending.get(msg.id);
    if (!entry) return; // late answer after a timeout or renderer reload
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error ?? "unknown renderer error"));
  });
  listenerAttached = true;
}

export function callRenderer(
  win: BrowserWindow,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  attachOnce();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${op} timed out after ${Math.round(timeoutMs / 1000)} s — is the app busy?`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send(MCP_CHANNELS.request, { id, op, args });
  });
}

/** Reject everything in flight (window closed / app quitting). */
export function cancelAllPending(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}
