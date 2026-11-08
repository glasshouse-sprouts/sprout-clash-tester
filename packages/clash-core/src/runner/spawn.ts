// Spawning the engine binary and collecting its output.

import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn the engine and collect its full stdout/stderr. When `onProgress`
 * is supplied, each complete stdout line is also passed through it as
 * the engine emits it — useful for streaming progress indicators.
 *
 * The line-buffering keeps cross-platform newline handling simple: we
 * split on `\n` and trim a trailing `\r` so the parser doesn't have
 * to special-case Windows newlines.
 */
export function spawnAndCollect(
  bin: string,
  args: string[],
  onProgress?: (line: string) => void,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";

    const flushLines = (chunk: string) => {
      stdout += chunk;
      if (!onProgress) return;
      lineBuffer += chunk;
      let idx: number;
      while ((idx = lineBuffer.indexOf("\n")) >= 0) {
        const raw = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        try {
          onProgress(line);
        } catch {
          // Swallow callback errors — don't kill the engine run because
          // the UI listener crashed.
        }
      }
    };

    child.stdout.on("data", (chunk) => flushLines(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      // Drain any final unterminated line so the callback sees it.
      if (onProgress && lineBuffer.length > 0) {
        try {
          onProgress(
            lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer,
          );
        } catch {
          /* see above */
        }
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
