// The `IpcResult` every IPC handler returns.

import { ProjectValidationError } from "@clash-tester/core";
import type { IpcResult } from "../shared/api.js";

export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function fail(err: unknown): IpcResult<never> {
  if (err instanceof ProjectValidationError) {
    return { ok: false, error: err.message, issues: err.issues };
  }
  if (err instanceof Error) return { ok: false, error: err.message };
  return { ok: false, error: String(err) };
}
