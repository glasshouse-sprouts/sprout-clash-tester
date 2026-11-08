// End-to-end test for the Node runner.
//
// Spawns the real Rust engine binary against the test IFCs vendored from
// Clashero (Building-Hvac.ifc + Building-Structural.ifc). Confirms:
//   - the runner can find the engine binary
//   - it writes a BCF when asked
//   - the structured summary is parsed and matches expectations
//   - misalignment via `translation` triggers a `no_aabb_overlap` warning
//
// Skipped when CLASH_BINARY isn't set and the default release binary
// isn't built — so contributors who don't have Rust installed can still
// run `npm test` for unit tests without a hard failure.

import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { run, getEnginePath } from "./runner.js";
import type { ClashRule } from "./types.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Walk up from this file to find the workspace root (the directory that
// contains engine/). vitest runs from the workspace root, but using
// import.meta-style resolution makes the test robust to changes in cwd.
function workspaceRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "engine", "Cargo.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate workspace root from " + HERE);
}

const ROOT = workspaceRoot();
const MODELS = path.join(ROOT, "engine", "tests", "models");
const HVAC = path.join(MODELS, "Building-Hvac.ifc");
const STR = path.join(MODELS, "Building-Structural.ifc");

const ENGINE = getEnginePath();
const ENGINE_AVAILABLE = existsSync(ENGINE);

// ─── Shared rule fixtures ─────────────────────────────────────────────────────

const sharedTolerance = 0.1; // 100 mm — same as engine's cli_tests baseline.

function ruleHvacVsStr(translationB?: [number, number, number]): ClashRule {
  return {
    name: "HVACxSTR",
    a: [{ file: HVAC, selector: "*", mode: "i" }],
    b: [
      {
        file: STR,
        selector: "*",
        mode: "i",
        translation: translationB,
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!ENGINE_AVAILABLE)("runner e2e — clash detection", () => {
  beforeAll(() => {
    // Sanity: the test fixtures should exist in the vendored engine.
    expect(existsSync(HVAC), `Missing fixture: ${HVAC}`).toBe(true);
    expect(existsSync(STR), `Missing fixture: ${STR}`).toBe(true);
  });

  it("runs against two overlapping IFCs and produces a BCF", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "clashtester-e2e-"));
    const bcfPath = path.join(work, "report.bcf");

    const result = await run({
      rules: [ruleHvacVsStr()],
      outputBcf: bcfPath,
      toleranceMeters: sharedTolerance,
    });

    expect(result.ok, `Engine failed: ${result.stderr}`).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.totalClashes).toBeGreaterThan(0);
    expect(result.perRule).toHaveLength(1);
    expect(result.perRule[0]?.name).toBe("HVACxSTR");
    expect(result.outputs.bcf).toBe(bcfPath);
    expect(existsSync(bcfPath), "BCF file should be written").toBe(true);
    expect(
      result.warnings.some((w) => w.kind === "no_aabb_overlap"),
      "Aligned files should not trigger a no_aabb_overlap warning"
    ).toBe(false);
  });

  it("groups every real clash exactly once (SPEC §13a)", async () => {
    const result = await run({
      rules: [ruleHvacVsStr()],
      toleranceMeters: sharedTolerance,
    });
    expect(result.ok, `Engine failed: ${result.stderr}`).toBe(true);
    const groups = result.groups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length).toBeLessThanOrEqual(result.clashes.length);
    const covered = groups.flatMap((g) => g.clashIndices).sort((a, b) => a - b);
    expect(covered).toEqual(result.clashes.map((_, i) => i));
  });

  it("proximity grouping never yields more groups than without it", async () => {
    const plain = await run({ rules: [ruleHvacVsStr()], toleranceMeters: sharedTolerance });
    const near = await run({
      rules: [ruleHvacVsStr()],
      toleranceMeters: sharedTolerance,
      grouping: { proximity: { enabled: true, radiusMetres: 5 } },
    });
    expect((near.groups ?? []).length).toBeLessThanOrEqual((plain.groups ?? []).length);
  });

  it("zero translation is a no-op", async () => {
    const r1 = await run({
      rules: [ruleHvacVsStr()],
      toleranceMeters: sharedTolerance,
    });
    const r2 = await run({
      rules: [ruleHvacVsStr([0, 0, 0])],
      toleranceMeters: sharedTolerance,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.totalClashes).toBe(r2.totalClashes);
  });

  it("large translation separates files and fires AABB warning", async () => {
    const result = await run({
      rules: [ruleHvacVsStr([500, 0, 0])],
      toleranceMeters: sharedTolerance,
    });

    expect(result.ok, `Engine stderr: ${result.stderr}`).toBe(true);
    expect(result.totalClashes).toBe(0);
    const warning = result.warnings.find((w) => w.kind === "no_aabb_overlap");
    expect(warning, "Expected no_aabb_overlap warning").toBeDefined();
    expect(warning?.files.some((f) => f.includes("Hvac"))).toBe(true);
    expect(warning?.files.some((f) => f.includes("Structural"))).toBe(true);
  });

  it("summary file is written and readable", async () => {
    const result = await run({
      rules: [ruleHvacVsStr()],
      toleranceMeters: sharedTolerance,
    });
    expect(existsSync(result.outputs.summary)).toBe(true);
    const raw = await readFile(result.outputs.summary, "utf-8");
    const parsed = JSON.parse(raw) as { total_clashes: number };
    expect(parsed.total_clashes).toBe(result.totalClashes);
  });

  it("classifies IFC2X3 flow elements by their type object (SPEC §6)", async () => {
    const file = path.join(MODELS, "ifc2x3-mep-types.ifc");
    const result = await run({
      rules: [
        {
          name: "HVACxSTR",
          a: [{ file, selector: "IfcDuct*", mode: "i" }],
          b: [{ file, selector: "IfcBeam*", mode: "i" }],
        },
      ],
    });
    expect(result.ok, `Engine failed: ${result.stderr}`).toBe(true);
    const duct = result.clashes.find((c) => c.typeClassA === "IfcDuctSegment");
    expect(duct).toMatchObject({ ifcTypeA: "IFCFLOWSEGMENT", predefinedTypeA: "RIGIDSEGMENT" });
    expect(result.clashes.map((c) => c.typeClassA).sort()).toEqual([
      "IfcDuctFitting",
      "IfcDuctSegment",
    ]);
    expect(result.warnings.map((w) => w.kind)).toContain("untyped_generic_mep");
  });
});

// When the engine binary isn't built, we still want one passing test so
// `npm test` doesn't report "no tests" in CI before the release build runs.
describe.skipIf(ENGINE_AVAILABLE)("runner e2e (engine binary missing)", () => {
  it("skipped — set CLASH_BINARY or build the engine to run e2e tests", () => {
    expect(true).toBe(true);
  });
});
