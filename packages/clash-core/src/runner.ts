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

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { groupsToTopics } from "./bcfTopics.js";
import { groupClashes } from "./grouping.js";
import type {
  AlignmentFileInput,
  AlignmentResult,
  ClashEntry,
  ClashRule,
  EngineWarning,
  OpeningCuts,
  RuleCount,
  RunOptions,
  RunResult,
} from "./types.js";

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

  // Parse the summary if it exists. If the engine crashed before writing
  // it, fall back to "no clashes, no rules, surface stderr".
  let totalClashes = 0;
  let perRule: RuleCount[] = [];
  let clashes: ClashEntry[] = [];
  let warnings: EngineWarning[] = [];
  let openingCuts: OpeningCuts | undefined;
  if (existsSync(summaryPath)) {
    try {
      const raw = await readFile(summaryPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        total_clashes: number;
        per_rule: {
          name: string;
          clashes: number;
          skipped_by_relations?: number;
          touch_count?: number;
          unconfirmed_count?: number;
        }[];
        clashes: {
          rule: string;
          ifc_type_a: string;
          ifc_type_b: string;
          guid_a: string;
          guid_b: string;
          file_a?: string;
          file_b?: string;
          position: [number, number, number];
          mode?: string;
          depth_metres?: number | null;
          gap_metres?: number | null;
          aabb_overlap_extents?: [number, number, number] | null;
          aabb_overlap_volume?: number | null;
          aabb_match?: number | null;
          volume_a?: number | null;
          volume_b?: number | null;
          centroid_distance?: number | null;
          status?: ClashEntry["status"] | null;
          distance_kind?: ClashEntry["distanceKind"] | null;
          type_class_a?: string | null;
          type_class_b?: string | null;
          predefined_type_a?: string | null;
          predefined_type_b?: string | null;
        }[];
        warnings: EngineWarning[];
        bcf_path?: string;
        opening_cuts?: {
          hosts_cut: number;
          openings: number;
          failed: string[];
          not_cut?: string[];
          open_mesh?: string[];
        } | null;
      };
      totalClashes = parsed.total_clashes ?? 0;
      perRule = (parsed.per_rule ?? []).map((r) => ({
        name: r.name,
        clashes: r.clashes,
        ...(typeof r.skipped_by_relations === "number"
          ? { skippedByRelations: r.skipped_by_relations }
          : {}),
        // Only the ifc-lite phase can touch / leave pairs unconfirmed.
        ...(opts.narrowPhase === "ifclite"
          ? { touchCount: r.touch_count ?? 0, unconfirmedCount: r.unconfirmed_count ?? 0 }
          : {}),
      }));
      warnings = parsed.warnings ?? [];
      if (parsed.opening_cuts) {
        openingCuts = {
          hostsCut: parsed.opening_cuts.hosts_cut,
          openings: parsed.opening_cuts.openings,
          failed: parsed.opening_cuts.failed ?? [],
          notCut: parsed.opening_cuts.not_cut ?? [],
          openMesh: parsed.opening_cuts.open_mesh ?? [],
        };
      }
      // Engine uses snake_case; map to our camelCase ClashEntry.
      // Older engine builds may not emit the depth/gap/AABB fields —
      // fall back to defaults so the runner stays backwards compatible.
      // `number` = list position + 1, matching the engine's BCF titles.
      clashes = (parsed.clashes ?? []).map((c, i) => ({
        number: i + 1,
        rule: c.rule,
        ifcTypeA: c.ifc_type_a,
        ifcTypeB: c.ifc_type_b,
        guidA: c.guid_a,
        guidB: c.guid_b,
        fileA: c.file_a ?? "",
        fileB: c.file_b ?? "",
        position: c.position,
        mode: (c.mode as "intersection" | "clearance" | undefined) ?? "",
        depthMetres: c.depth_metres ?? null,
        gapMetres: c.gap_metres ?? null,
        aabbOverlapExtents: c.aabb_overlap_extents ?? null,
        aabbOverlapVolume: c.aabb_overlap_volume ?? null,
        aabbMatch: c.aabb_match ?? null,
        volumeA: c.volume_a ?? null,
        volumeB: c.volume_b ?? null,
        centroidDistanceMetres: c.centroid_distance ?? null,
        ...(c.status ? { status: c.status } : {}),
        ...(c.distance_kind ? { distanceKind: c.distance_kind } : {}),
        ...(c.type_class_a ? { typeClassA: c.type_class_a } : {}),
        ...(c.type_class_b ? { typeClassB: c.type_class_b } : {}),
        ...(c.predefined_type_a ? { predefinedTypeA: c.predefined_type_a } : {}),
        ...(c.predefined_type_b ? { predefinedTypeB: c.predefined_type_b } : {}),
      }));
    } catch (e) {
      // Don't throw — surface as a synthetic warning so the caller knows
      // the summary file existed but couldn't be parsed.
      warnings.push({
        kind: "summary_parse_failed",
        message: `Could not parse engine summary file: ${(e as Error).message}`,
        files: [],
      });
    }
  }

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

// ─── Internal helpers ────────────────────────────────────────────────────────

interface SpawnResult {
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
function spawnAndCollect(
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

  const raw = await readFile(outputPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    files: {
      path: string;
      origin: [number, number, number];
      effective_origin: [number, number, number];
      cluster: string;
      length_unit: string;
      map_conversion: {
        eastings: number;
        northings: number;
        orthogonal_height: number;
      } | null;
    }[];
    clusters: {
      label: string;
      centre: [number, number, number];
      files: string[];
    }[];
    warnings: EngineWarning[];
  };

  return {
    ok: true,
    exitCode,
    // Map engine snake_case → our camelCase, same pattern as `run`.
    files: parsed.files.map((f) => ({
      path: f.path,
      origin: f.origin,
      effectiveOrigin: f.effective_origin,
      cluster: f.cluster,
      lengthUnit: f.length_unit,
      mapConversion: f.map_conversion
        ? {
            eastings: f.map_conversion.eastings,
            northings: f.map_conversion.northings,
            orthogonalHeight: f.map_conversion.orthogonal_height,
          }
        : null,
    })),
    clusters: parsed.clusters,
    warnings: parsed.warnings,
    stderr,
  };
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
