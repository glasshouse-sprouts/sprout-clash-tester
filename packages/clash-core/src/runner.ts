// Node-side wrapper around the Rust `clash` binary.
//
// Responsibilities:
//   1. Serialise the caller's `ClashRule[]` to the engine's clash-set JSON.
//   2. Spawn `clash detect --clash-set <tmpfile> --summary <tmpfile> [...]`.
//   3. Read the structured summary the engine writes (JSON sidecar) so we
//      don't have to regex-parse stdout for clash counts.
//   4. Surface the structured warnings (kind, message, files).
//
// The runner is the SINGLE place that knows how to talk to the engine —
// the CLI and MCP server import this and reuse it. Keeps behaviour
// consistent across the three front doors.
//
// Process spawning and reading the engine's JSON output live in ./runner/.

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { groupsToTopics } from "./bcfTopics.js";
import { groupClashes } from "./grouping.js";
import { readAlignmentOutput } from "./runner/alignment.js";
import { spawnAndCollect } from "./runner/spawn.js";
import { readSummary } from "./runner/summary.js";
import type { AlignmentFileInput, AlignmentResult, RunOptions, RunResult } from "./types.js";

// ─── Engine location ─────────────────────────────────────────────────────────

/**
 * Resolve the path to the `clash` binary.
 *
 * Priority:
 *  1. Explicit `enginePath` in `RunOptions`.
 *  2. `CLASH_BINARY` env var (used in tests / packaged builds).
 *  3. Repo-relative fallback: `engine/target/release/clash` (or `.exe` on
 *     Windows) walking up from this file's location.
 */
function resolveEnginePath(explicit?: string): string {
  if (explicit) return explicit;
  const envPath = process.env.CLASH_BINARY;
  if (envPath) return envPath;

  // Walk up from this file to find the workspace root (the one with engine/).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const binName = process.platform === "win32" ? "clash.exe" : "clash";
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "engine", "target", "release", binName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort — return the most likely path so the spawn error is
  // informative ("ENOENT: …/engine/target/release/clash").
  return path.join(here, "..", "..", "..", "engine", "target", "release", binName);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run clash detection against a set of rules. Writes a BCF if asked,
 * always writes a JSON summary the runner immediately reads back.
 *
 * Never throws on engine *failure* — non-zero exit codes surface via
 * `result.ok === false` so the caller can decide. Does throw on setup
 * errors (e.g. can't write the temp file).
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const enginePath = resolveEnginePath(opts.enginePath);

  // Set up a clean temp work directory so nothing leaks between runs.
  const workRoot = opts.workDir ?? tmpdir();
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(path.join(workRoot, "clashtester-"));

  const clashSetPath = path.join(work, "clash-set.json");
  const summaryPath = path.join(work, "summary.json");

  // Engine's clash-set format is `Vec<ClashSet>` — same as our ClashRule[].
  await writeFile(clashSetPath, JSON.stringify(opts.rules, null, 2), "utf-8");

  // Build the argv. Always pass --summary so the runner has structured data
  // to parse. BCF output is optional; per-group topics need the groups
  // first, so in that mode the BCF is written after detection (below).
  const bcfPerGroup = opts.bcfTopics === "group";
  const args = ["detect", "--clash-set", clashSetPath, "--summary", summaryPath];
  if (opts.outputBcf && !bcfPerGroup) {
    args.push("--output", opts.outputBcf);
  }
  if (opts.skipRelatedElements === false) {
    args.push("--no-relation-skip");
  }
  if (opts.narrowPhase === "ifclite") {
    args.push("--narrow-phase", "ifclite");
    if (opts.reportTouch) args.push("--report-touch");
  }
  if (typeof opts.toleranceMeters === "number") {
    args.push("--tolerance", String(opts.toleranceMeters));
  }
  if (typeof opts.minPenetrationMeters === "number") {
    args.push("--min-penetration", String(opts.minPenetrationMeters));
  }

  const { stdout, stderr, exitCode } = await spawnAndCollect(
    enginePath,
    args,
    opts.onProgress,
  );
  const { totalClashes, perRule, clashes, warnings, openingCuts } = await readSummary(
    summaryPath,
    opts.narrowPhase,
  );

  const groups = groupClashes(clashes, opts.grouping);

  // Per-group BCF (SPEC §13c): topics from the groups, written by the
  // engine's own (BIMcollab-tested) writer via `clash bcf`.
  let bcfExit = 0;
  let allStdout = stdout;
  let allStderr = stderr;
  if (bcfPerGroup && opts.outputBcf && exitCode === 0) {
    const topicsPath = path.join(work, "topics.json");
    await writeFile(
      topicsPath,
      JSON.stringify(groupsToTopics(groups, clashes), null, 2),
      "utf-8",
    );
    const bcf = await spawnAndCollect(enginePath, [
      "bcf",
      "--topics",
      topicsPath,
      "--output",
      opts.outputBcf,
    ]);
    bcfExit = bcf.exitCode;
    allStdout += bcf.stdout;
    allStderr += bcf.stderr;
    if (bcf.exitCode !== 0) {
      warnings.push({
        kind: "bcf_failed",
        message: `Writing the per-group BCF failed (exit ${bcf.exitCode}): ${bcf.stderr.trim()}`,
        files: [],
      });
    }
  }

  return {
    ok: exitCode === 0 && bcfExit === 0,
    exitCode: exitCode !== 0 ? exitCode : bcfExit,
    totalClashes,
    perRule,
    clashes,
    groups,
    warnings,
    ...(openingCuts ? { openingCuts } : {}),
    outputs: {
      bcf: opts.outputBcf,
      summary: summaryPath,
    },
    stdout: allStdout,
    stderr: allStderr,
  };
}

// ─── Quick alignment pre-check ────────────────────────────────────────────────

/**
 * Run the engine's fast IFCSITE-origin pre-check on a list of files.
 *
 * Loads only STEP text headers — no geometry pass. Returns the per-file
 * origins, the cluster grouping, and any structured warnings the engine
 * emitted (currently only `placement_mismatch_quick` when files split
 * into >1 cluster).
 *
 * Typically called by the desktop app whenever the user's file list
 * changes (debounced so multiple drops batch into one check).
 */
export async function checkAlignment(opts: {
  files: AlignmentFileInput[];
  enginePath?: string;
  workDir?: string;
}): Promise<AlignmentResult> {
  const enginePath = resolveEnginePath(opts.enginePath);
  const workRoot = opts.workDir ?? tmpdir();
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(path.join(workRoot, "clashtester-align-"));
  const inputPath = path.join(work, "input.json");
  const outputPath = path.join(work, "result.json");

  // Engine input is `[{ file, translation? }]` — same shape as our
  // AlignmentFileInput, with `translation` optional.
  await writeFile(
    inputPath,
    JSON.stringify(
      opts.files.map((f) => ({
        file: f.file,
        ...(f.translation ? { translation: f.translation } : {}),
      })),
      null,
      2,
    ),
    "utf-8",
  );

  const { stderr, exitCode } = await spawnAndCollect(enginePath, [
    "check-alignment",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ]);

  if (exitCode !== 0 || !existsSync(outputPath)) {
    return {
      ok: false,
      exitCode,
      files: [],
      clusters: [],
      warnings: [],
      stderr,
    };
  }
  return readAlignmentOutput(outputPath, exitCode, stderr);
}

// Re-export everything so consumers can `import { run, ClashRule } from "@clash-tester/core"`.
export type {
  AlignmentCluster,
  AlignmentFileInput,
  AlignmentFileResult,
  AlignmentResult,
  ClashEntry,
  ClashRule,
  EngineWarning,
  RuleCount,
  RunOptions,
  RunResult,
} from "./types.js";

/** Convenience helper for tests — the resolved path to the engine binary. */
export function getEnginePath(explicit?: string): string {
  return resolveEnginePath(explicit);
}
