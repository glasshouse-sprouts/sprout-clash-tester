#!/usr/bin/env node
// @clash-tester/cli — `clashtester` command-line interface.
//
// Three subcommands:
//   init <path>      — write a sample .clashproj at <path>
//   validate <path>  — load and validate a .clashproj without running
//   run <path>       — run clash detection, write BCF + JSON + CSV
//
// Designed for non-technical users: friendly help, plain-English errors,
// no jargon in stdout unless you opt in with --json.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";

import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  compareNarrowPhases,
  expandProjectToRules,
  formatNotClashes,
  formatOpeningCuts,
  getPreset,
  loadProject,
  ProjectValidationError,
  run,
  summariseGroups,
  VERSION,
  writeResultCsv,
  writeResultJson,
  type Project,
  type ProjectRule,
  type RunOptions,
  type RunResult,
} from "@clash-tester/core";
import { formatComparison } from "./compareOutput.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Print an error to stderr in a way a non-programmer can read. Validation
 * errors get bullet-listed; other errors get the message and a hint.
 */
function fail(err: unknown, hint?: string): never {
  if (err instanceof ProjectValidationError) {
    process.stderr.write("\nProject file is invalid:\n");
    for (const issue of err.issues) {
      process.stderr.write(`  - ${issue}\n`);
    }
  } else if (err instanceof Error) {
    process.stderr.write(`\nError: ${err.message}\n`);
  } else {
    process.stderr.write(`\nError: ${String(err)}\n`);
  }
  if (hint) process.stderr.write(`\nHint: ${hint}\n`);
  process.exit(1);
}

/** Format a duration in ms into something a human can read. */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Resolve the standard outputs folder for a `.clashproj` file. Per SPEC §12
 * open question, we default to `outputs/` next to the project. The user
 * can override with --out.
 */
function defaultOutputsDir(projectPath: string): string {
  return path.join(path.dirname(path.resolve(projectPath)), "outputs");
}

// ─── Pretty stdout helpers ────────────────────────────────────────────────────

const BAR = "─".repeat(48);

function printHeader(title: string): void {
  process.stdout.write(`\n${title}\n${BAR}\n`);
}

function printRunSummary(result: RunResult, durationMs: number): void {
  printHeader("Clash detection — summary");
  process.stdout.write(`Total clashes : ${result.totalClashes}\n`);
  process.stdout.write(`Grouped into  : ${summariseGroups(result.groups ?? [])}\n`);
  process.stdout.write(`Time taken    : ${fmtDuration(durationMs)}\n`);
  if (result.openingCuts) {
    process.stdout.write(`Geometry      : ${formatOpeningCuts(result.openingCuts)}\n`);
  }
  if (result.perRule.length > 0) {
    process.stdout.write("By rule:\n");
    for (const r of result.perRule) {
      const skipped = r.skippedByRelations
        ? `  (${r.skippedByRelations} related pair(s) skipped)`
        : "";
      process.stdout.write(`  - ${r.name.padEnd(20)} ${r.clashes}${skipped}${formatNotClashes(r)}\n`);
    }
  }
  if (result.warnings.length > 0) {
    process.stdout.write("\nWarnings:\n");
    for (const w of result.warnings) {
      process.stdout.write(`  ! [${w.kind}] ${w.message}\n`);
    }
  }
}

function printOutputPaths(paths: { bcf?: string; json?: string; csv?: string }): void {
  process.stdout.write("\nOutput files:\n");
  if (paths.bcf) process.stdout.write(`  BCF  : ${paths.bcf}\n`);
  if (paths.json) process.stdout.write(`  JSON : ${paths.json}\n`);
  if (paths.csv) process.stdout.write(`  CSV  : ${paths.csv}\n`);
}

// ─── Subcommand: init ─────────────────────────────────────────────────────────

/** Build a barebones project the user can immediately edit and run. */
function buildSampleProject(): Project {
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: "My clash test",
    createdAt: new Date().toISOString(),
    files: [
      {
        id: "ark",
        path: "models/ARK.ifc",
        discipline: "ARCH",
      },
      {
        id: "vent",
        path: "models/VENT.ifc",
        discipline: "HVAC",
      },
    ],
    rules: [
      {
        name: "HVACxARCH",
        preset: null,
        enabled: true,
        a: { fileId: "vent", selector: "IfcDuct*", mode: "i" },
        b: { fileId: "ark", selector: "IfcWall|IfcSlab", mode: "i" },
      },
    ],
    settings: {
      toleranceMeters: 0,
      minPenetrationMeters: 0.005,
    },
  };
}

/**
 * Build a sample project pre-wired for a named preset. The placeholder
 * file paths reflect the preset's expected disciplines so the user only
 * has to swap the paths and run.
 */
function buildPresetProject(presetName: string): Project {
  const preset = getPreset(presetName);
  if (!preset) {
    throw new Error(
      `Unknown preset: "${presetName}". Run \`clashtester init --help\` for the list of shipped presets.`,
    );
  }
  const aDisc = preset.sideA.discipline;
  const bDisc = preset.sideB.discipline;
  const aId = aDisc.toLowerCase();
  const bId = bDisc.toLowerCase();
  // Avoid id collision when both sides share a discipline (unusual).
  const bIdSafe = aId === bId ? `${bId}-2` : bId;
  return {
    version: CURRENT_PROJECT_SCHEMA_VERSION,
    name: `My ${preset.name} test`,
    createdAt: new Date().toISOString(),
    files: [
      { id: aId, path: `models/${aDisc}.ifc`, discipline: aDisc },
      { id: bIdSafe, path: `models/${bDisc}.ifc`, discipline: bDisc },
    ],
    rules: [
      {
        name: preset.name,
        preset: preset.name,
        enabled: true,
      } as ProjectRule,
    ],
    settings: {
      toleranceMeters: 0,
      minPenetrationMeters: 0.005,
    },
  };
}

async function cmdInit(
  outputPath: string,
  opts: { force?: boolean; preset?: string },
): Promise<void> {
  if (existsSync(outputPath) && !opts.force) {
    fail(
      new Error(`File already exists: ${outputPath}`),
      "Pass --force to overwrite.",
    );
  }
  let project: Project;
  try {
    project = opts.preset ? buildPresetProject(opts.preset) : buildSampleProject();
  } catch (err) {
    fail(err);
  }
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, JSON.stringify(project, null, 2) + "\n", "utf-8");
  process.stdout.write(`Created ${outputPath}\n`);
  if (opts.preset) {
    process.stdout.write(
      `Using preset: ${opts.preset}\n` +
        `Replace the placeholder paths in 'files' with your real IFC paths, then run:\n` +
        `  clashtester run ${outputPath}\n`,
    );
  } else {
    process.stdout.write(`Edit it, then run:  clashtester run ${outputPath}\n`);
  }
}

// ─── Subcommand: validate ─────────────────────────────────────────────────────

async function cmdValidate(projectPath: string): Promise<void> {
  try {
    const project = await loadProject(projectPath);
    process.stdout.write(`OK — ${projectPath} is valid\n`);
    process.stdout.write(`  Name      : ${project.name}\n`);
    process.stdout.write(`  Files     : ${project.files.length}\n`);
    const enabledRules = project.rules.filter((r) => r.enabled !== false);
    process.stdout.write(`  Rules     : ${enabledRules.length} enabled (${project.rules.length} total)\n`);
    process.stdout.write(
      `  Tolerance : ${project.settings.toleranceMeters} m\n`,
    );
    process.stdout.write(
      `  Min depth : ${project.settings.minPenetrationMeters} m\n`,
    );
  } catch (err) {
    fail(err, "Check the file's JSON syntax and field names against SPEC.md §7.");
  }
}

// ─── Subcommand: run ──────────────────────────────────────────────────────────

interface RunCmdOptions {
  out?: string;
  /**
   * Commander maps `--bcf / --no-bcf` to the `bcf` boolean — `false` when
   * the user passes `--no-bcf`. Default is `true` (write the BCF).
   */
  bcf?: boolean;
  /**
   * When set, the CLI suppresses the pretty stdout and instead writes the
   * full `RunResult` as JSON to stdout. Useful in shell pipelines and CI.
   */
  json?: boolean;
  enginePath?: string;
  /** `--bcf-topics clash|group` — overrides `settings.bcfTopics` (SPEC §13c). */
  bcfTopics?: string;
  /**
   * Commander maps `--no-relation-skip` to `relationSkip: false`; default
   * true. Either this flag or `settings.skipRelatedElements: false` turns
   * the IFC-relation skip off (SPEC §13e).
   */
  relationSkip?: boolean;
  /** `--narrow-phase parry|ifclite` — overrides `settings.narrowPhase` (SPEC §13g). */
  narrowPhase?: string;
  /** `--report-touch` — ifc-lite: list touching / unconfirmed pairs too. */
  reportTouch?: boolean;
  /** `--compare-narrow-phase` — run with both phases, print the agreement. */
  compareNarrowPhase?: boolean;
}

async function cmdRun(projectPath: string, opts: RunCmdOptions): Promise<void> {
  if (opts.bcfTopics !== undefined && opts.bcfTopics !== "clash" && opts.bcfTopics !== "group") {
    fail(new Error(`--bcf-topics must be "clash" or "group", got "${opts.bcfTopics}"`));
  }
  if (opts.narrowPhase !== undefined && opts.narrowPhase !== "parry" && opts.narrowPhase !== "ifclite") {
    fail(new Error(`--narrow-phase must be "parry" or "ifclite", got "${opts.narrowPhase}"`));
  }
  let project: Project;
  try {
    project = await loadProject(projectPath);
  } catch (err) {
    fail(err, "Run `clashtester validate` for details.");
  }
  const bcfTopics = (opts.bcfTopics as "clash" | "group" | undefined) ?? project.settings.bcfTopics ?? "clash";

  const outputsDir = opts.out ?? defaultOutputsDir(projectPath);
  await mkdir(outputsDir, { recursive: true });
  const writeBcf = opts.bcf !== false; // default true; false when --no-bcf
  const bcfPath = writeBcf ? path.join(outputsDir, "report.bcf") : undefined;
  const jsonPath = path.join(outputsDir, "clashes.json");
  const csvPath = path.join(outputsDir, "clashes.csv");

  // Pretty stdout in default mode, captured warnings in --json mode.
  const warningCollector: string[] = [];
  const onExpandWarning = opts.json
    ? (m: string) => warningCollector.push(m)
    : (m: string) => process.stderr.write(`! ${m}\n`);
  const rules = expandProjectToRules(project, { onWarning: onExpandWarning });
  if (rules.length === 0) {
    fail(
      new Error("No rules to evaluate"),
      "Check that at least one rule is enabled, and that preset rules find matching files by discipline.",
    );
  }

  if (!opts.json) {
    printHeader(`Running ${project.name}`);
    process.stdout.write(`Project   : ${projectPath}\n`);
    process.stdout.write(`Files     : ${project.files.length} IFC(s)\n`);
    process.stdout.write(`Rules     : ${rules.length} enabled\n`);
    process.stdout.write(`Tolerance : ${project.settings.toleranceMeters} m\n`);
    if (writeBcf) process.stdout.write(`BCF topics: one per ${bcfTopics}\n`);
    if (project.settings.narrowPhase === "ifclite" || opts.narrowPhase === "ifclite") {
      process.stdout.write(`Narrow    : ifc-lite\n`);
    }
  }

  const runOptions: RunOptions = {
    rules,
    outputBcf: bcfPath,
    bcfTopics,
    skipRelatedElements: opts.relationSkip !== false && project.settings.skipRelatedElements !== false,
    narrowPhase: (opts.narrowPhase as "parry" | "ifclite" | undefined) ?? project.settings.narrowPhase,
    reportTouch: opts.reportTouch === true || project.settings.reportTouch === true,
    toleranceMeters: project.settings.toleranceMeters,
    minPenetrationMeters: project.settings.minPenetrationMeters,
    grouping: project.settings.grouping,
    enginePath: opts.enginePath,
  };
  if (opts.compareNarrowPhase) {
    const cmp = await compareNarrowPhases(runOptions);
    const failed = [cmp.parry, cmp.ifclite].find((r) => !r.ok);
    if (failed) {
      process.stderr.write(failed.stderr);
      fail(new Error(`Engine exited with code ${failed.exitCode}`));
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({ rules: cmp.rules }, null, 2) + "\n");
    } else {
      printHeader("Narrow phase comparison — parry vs ifc-lite (no files written)");
      process.stdout.write(formatComparison(cmp.rules) + "\n");
    }
    return;
  }

  const t0 = Date.now();
  const result = await run(runOptions);
  const elapsedMs = Date.now() - t0;

  if (!result.ok) {
    process.stderr.write(result.stderr);
    fail(
      new Error(`Engine exited with code ${result.exitCode}`),
      "Inspect the stderr above. If the engine binary is missing, build it with `cargo build --release` in engine/.",
    );
  }

  // Always write JSON + CSV alongside BCF (regardless of --json).
  await writeResultJson(result, jsonPath);
  await writeResultCsv(result, csvPath);

  if (opts.json) {
    // Machine-readable: full RunResult on stdout. We add a top-level
    // `expansionWarnings` field with any expansion-time warnings (e.g.
    // preset rule skipped) and `outputs.json/csv` so the caller can
    // find the on-disk files.
    const payload = {
      ...result,
      expansionWarnings: warningCollector,
      durationMs: elapsedMs,
      outputs: { ...result.outputs, json: jsonPath, csv: csvPath },
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  printRunSummary(result, elapsedMs);
  printOutputPaths({ bcf: bcfPath, json: jsonPath, csv: csvPath });
}

// ─── Wire up commander ────────────────────────────────────────────────────────

const program = new Command();

program
  .name("clashtester")
  .description("IFC clash detection — CLI front door.")
  .version(VERSION, "-v, --version", "show version");

program
  .command("init")
  .description("Create a new sample .clashproj you can edit and run.")
  .argument("<path>", "Where to write the project file (e.g. ./my-test.clashproj)")
  .option("-f, --force", "overwrite the file if it already exists")
  .option(
    "-p, --preset <name>",
    "pre-fill the sample with a built-in preset (e.g. HVACxSTR, MEPxARCH)",
  )
  .action(async (p: string, opts: { force?: boolean; preset?: string }) => {
    try {
      await cmdInit(p, opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("validate")
  .description("Check that a .clashproj file is well-formed without running detection.")
  .argument("<path>", "Path to the .clashproj file")
  .action(async (p: string) => {
    await cmdValidate(p);
  });

program
  .command("run")
  .description("Run clash detection on a .clashproj. Writes BCF + JSON + CSV to outputs/.")
  .argument("<path>", "Path to the .clashproj file")
  .option(
    "-o, --out <dir>",
    "directory for the output files (default: outputs/ next to the project)",
  )
  .option("--no-bcf", "skip writing the BCF file (JSON + CSV only)")
  .option(
    "--no-relation-skip",
    "also report pairs that belong together in the IFC (door in its wall, opening in its host, parts of an assembly)",
  )
  .option(
    "--narrow-phase <parry|ifclite>",
    "narrow phase that decides a clash; overrides the project setting (default parry)",
  )
  .option("--report-touch", "ifc-lite: also list touching pairs and unconfirmed box estimates")
  .option(
    "--compare-narrow-phase",
    "run with parry and with ifc-lite; print both / only-parry / only-ifc-lite per rule (writes no files)",
  )
  .option(
    "--bcf-topics <clash|group>",
    "BCF: one topic per clash (default) or per clash group; overrides the project setting",
  )
  .option(
    "--json",
    "suppress pretty stdout; write the full RunResult JSON to stdout instead",
  )
  .option(
    "--engine-path <path>",
    "absolute path to the clash binary (default: auto-detect)",
  )
  .action(async (p: string, opts: RunCmdOptions) => {
    await cmdRun(p, opts);
  });

await program.parseAsync(process.argv);
